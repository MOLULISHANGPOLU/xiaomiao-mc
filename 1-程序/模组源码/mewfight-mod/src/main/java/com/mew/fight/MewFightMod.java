package com.mew.fight;

import com.mojang.blaze3d.platform.InputConstants;
import com.mojang.brigadier.arguments.DoubleArgumentType;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.command.v2.ClientCommands;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keymapping.v1.KeyMappingHelper;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.network.chat.Component;
import net.minecraft.world.entity.monster.Monster;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;

/**
 * 小喵自动战斗模组（纯客户端）。
 * 职责：锁最近敌对生物、把视角转过去、按武器冷却挥剑、受伤自动还手。
 * 走位交给 Baritone（#follow / #goto），本模组只负责瞄准与攻击。
 * 设置存 mewfight.properties，两个客户端共享（经环境变量 MEWFIGHT_SHARED 指到同一目录；没设则用当前工作目录）：
 * 用户端面板只作遥控（写文件），小喵端（LittleMew）读文件并执行战斗。
 */
public class MewFightMod implements ClientModInitializer {

    private static final Path SETTINGS = resolveSettings();
    private static final String LITTLEMEW = "LittleMew";

    /** 共享设置文件位置：优先环境变量 MEWFIGHT_SHARED 指定的目录，兜底当前工作目录。 */
    private static Path resolveSettings() {
        String dir = System.getenv("MEWFIGHT_SHARED");
        if (dir != null && !dir.isBlank()) return Path.of(dir.trim(), "mewfight.properties");
        return Path.of("mewfight.properties");
    }

    private static boolean enabled = false;
    private static double range = 16.0;
    private static boolean retaliate = true;      // 受伤还手
    private static boolean lineOfSight = true;    // 视线检测（不穿墙）
    private static String gamemode = "creative";   // 目标游戏模式 creative/survival（面板遥控）
    private static String appliedGamemode = null;  // 已应用到服务器的模式（防重复发命令）
    private static int respawnCooldown = 0;        // 死亡重生防抖

    private static KeyMapping openPanelKey;
    private static int tickCounter = 0;
    private static long settingsMtime = -1;

    @Override
    public void onInitializeClient() {
        loadSettings();
        ClientCommandRegistrationCallback.EVENT.register((dispatcher, registryAccess) ->
                dispatcher.register(ClientCommands.literal("mewfight")
                        .executes(ctx -> {
                            toggleEnabled();
                            return 1;
                        })
                        .then(ClientCommands.literal("on").executes(ctx -> {
                            setEnabled(true);
                            return 1;
                        }))
                        .then(ClientCommands.literal("off").executes(ctx -> {
                            setEnabled(false);
                            return 1;
                        }))
                        .then(ClientCommands.literal("gui").executes(ctx -> {
                            openPanel();
                            return 1;
                        }))
                        .then(ClientCommands.literal("range")
                                .then(ClientCommands.argument("r", DoubleArgumentType.doubleArg(1.0, 64.0))
                                        .executes(ctx -> {
                                            setRange(DoubleArgumentType.getDouble(ctx, "r"));
                                            return 1;
                                        })))));

        openPanelKey = KeyMappingHelper.registerKeyMapping(
                new KeyMapping("key.mewfight.panel", InputConstants.KEY_G, KeyMapping.Category.MISC));

        ClientTickEvents.END_CLIENT_TICK.register(MewFightMod::tick);
    }

    private static void tick(Minecraft client) {
        VoicechatReadyPlugin.poll(); // 语音就绪检测（与战斗开关无关）
        // 快捷键打开控制面板（G 键）
        while (openPanelKey != null && openPanelKey.consumeClick()) {
            loadSettings(); // 打开面板前先同步另一侧的最新设置
            client.setScreen(new MewFightScreen());
        }
        LocalPlayer player = client.player;
        if (player == null) {
            return;
        }

        // 死亡自动重生（隐藏客户端没人点死亡屏幕的重生按钮）
        if (isLittleMew(player) && player.isDeadOrDying()) {
            if (respawnCooldown <= 0) {
                player.respawn();
                respawnCooldown = 40; // 2 秒防抖，避免重复发重生包
                reply("§c检测到死亡，自动重生");
            }
            respawnCooldown--;
            return;
        }
        respawnCooldown = 0;

        // 每 20 tick（约 1 秒）检查设置文件是否被另一侧改过，有改动就同步 + 同步游戏模式
        if (++tickCounter >= 20) {
            tickCounter = 0;
            long mt = mtime();
            if (mt != settingsMtime) {
                settingsMtime = mt;
                loadSettings();
            }
            syncGameMode(player);
        }

        if (!enabled) {
            return;
        }
        if (!player.isAlive() || player.isSpectator()) {
            return;
        }
        if (!isLittleMew(player)) {
            return; // 只有小喵（LittleMew）执行战斗；用户端的面板只作遥控，不打架
        }
        if (client.screen != null) {
            return; // 开着界面（背包/聊天/面板）时不打架
        }

        Monster target = acquireTarget(client, player);
        if (target == null) {
            return; // 没有可打的目标就停下（视角交还 Baritone）
        }

        aimAt(player, target);
        // 只在武器冷却转满时攻击，保证每一下都是满伤害
        if (player.getAttackStrengthScale(0.0F) >= 1.0F) {
            client.gameMode.attack(player, target);
        }
    }

    private static Monster acquireTarget(Minecraft client, LocalPlayer player) {
        ClientLevel level = client.level;
        if (level == null) {
            return null;
        }
        double rangeSq = range * range;

        // 1) 还手优先：最近一次攻击我的敌对生物（还在范围内、还活着、没隔墙）
        if (retaliate && player.getLastHurtByMob() instanceof Monster avenger
                && avenger.isAlive()
                && player.distanceToSqr(avenger) <= rangeSq
                && (!lineOfSight || player.hasLineOfSight(avenger))) {
            return avenger;
        }

        // 2) 否则找范围内最近的敌对生物（不碰玩家/村民/宠物/假人，它们都不是 Monster）
        Vec3 eye = player.getEyePosition();
        AABB box = new AABB(
                eye.x - range, eye.y - range, eye.z - range,
                eye.x + range, eye.y + range, eye.z + range);

        Monster nearest = null;
        double best = rangeSq;
        for (Monster m : level.getEntitiesOfClass(Monster.class, box, Monster::isAlive)) {
            double d = player.distanceToSqr(m);
            if (d <= best && (!lineOfSight || player.hasLineOfSight(m))) {
                best = d;
                nearest = m;
            }
        }
        return nearest;
    }

    private static void aimAt(LocalPlayer player, Monster target) {
        Vec3 eye = player.getEyePosition();
        Vec3 aim = target.getEyePosition();
        double dx = aim.x - eye.x;
        double dy = aim.y - eye.y;
        double dz = aim.z - eye.z;
        double horiz = Math.sqrt(dx * dx + dz * dz);
        float yaw = (float) (Math.toDegrees(Math.atan2(dz, dx)) - 90.0);
        float pitch = (float) (-Math.toDegrees(Math.atan2(dy, horiz)));
        player.setYRot(yaw);
        player.setXRot(pitch);
    }

    // ---- 面板可调项（供 MewFightScreen 与命令调用）----
    public static boolean isEnabled() {
        return enabled;
    }

    public static double getRange() {
        return range;
    }

    public static boolean isRetaliate() {
        return retaliate;
    }

    public static boolean isLineOfSight() {
        return lineOfSight;
    }

    public static void toggleEnabled() {
        setEnabled(!enabled);
    }

    public static void toggleRetaliate() {
        retaliate = !retaliate;
        saveSettings();
        reply("受伤还手已" + (retaliate ? "§a开启§r" : "§7关闭§r"));
    }

    public static void toggleLineOfSight() {
        lineOfSight = !lineOfSight;
        saveSettings();
        reply("视线检测（不穿墙）已" + (lineOfSight ? "§a开启§r" : "§7关闭§r"));
    }

    public static String getGamemode() {
        return gamemode;
    }

    public static void toggleGamemode() {
        gamemode = "creative".equals(gamemode) ? "survival" : "creative";
        saveSettings();
        reply("目标模式已设为" + ("creative".equals(gamemode) ? "§a创造§r" : "§c生存§r") + "，小喵端会自动切换");
    }

    public static void adjustRange(int delta) {
        setRange(clamp(range + delta));
    }

    private static void setEnabled(boolean on) {
        enabled = on;
        saveSettings();
        reply("战斗模组已" + (on ? "§a开启§r（自动锁敌·瞄准·挥剑）" : "§7关闭§r") + "，锁定范围 " + (int) range + " 格");
    }

    private static void setRange(double r) {
        range = clamp(r);
        saveSettings();
        reply("锁定范围改为 " + (int) range + " 格");
    }

    private static void openPanel() {
        loadSettings();
        Minecraft.getInstance().setScreen(new MewFightScreen());
    }

    // ---- 文件同步 / 身份判断 ----
    private static boolean isLittleMew(LocalPlayer player) {
        return LITTLEMEW.equals(player.getName().getString());
    }

    private static long mtime() {
        try {
            return Files.getLastModifiedTime(SETTINGS).toMillis();
        } catch (Exception e) {
            return 0;
        }
    }

    private static void loadSettings() {
        try {
            if (Files.exists(SETTINGS)) {
                Properties p = new Properties();
                try (InputStream in = Files.newInputStream(SETTINGS)) {
                    p.load(in);
                }
                enabled = Boolean.parseBoolean(p.getProperty("enabled", "false"));
                range = clamp(Double.parseDouble(p.getProperty("range", "16.0")));
                retaliate = Boolean.parseBoolean(p.getProperty("retaliate", "true"));
                lineOfSight = Boolean.parseBoolean(p.getProperty("los", "true"));
                gamemode = p.getProperty("gamemode", "creative");
            }
        } catch (Exception ignored) {
        }
    }

    private static void saveSettings() {
        try {
            Files.createDirectories(SETTINGS.getParent());
            Properties p = new Properties();
            p.setProperty("enabled", String.valueOf(enabled));
            p.setProperty("range", String.valueOf((int) range));
            p.setProperty("retaliate", String.valueOf(retaliate));
            p.setProperty("los", String.valueOf(lineOfSight));
            p.setProperty("gamemode", String.valueOf(gamemode));
            try (OutputStream out = Files.newOutputStream(SETTINGS)) {
                p.store(out, "mewfight settings");
            }
            settingsMtime = mtime();
        } catch (Exception ignored) {
        }
    }

    private static double clamp(double v) {
        return Math.max(1.0, Math.min(64.0, v));
    }

    // 游戏模式同步：目标模式（gamemode 字段，来自文件/面板）变了就发命令切
    private static void syncGameMode(LocalPlayer player) {
        if (!isLittleMew(player) || gamemode == null) {
            return;
        }
        if (gamemode.equals(appliedGamemode)) {
            return; // 目标没变，跳过
        }
        player.connection.sendCommand("gamemode " + gamemode);
        appliedGamemode = gamemode;
        reply("已切换为" + ("creative".equals(gamemode) ? "§a创造§r" : "§c生存§r") + "模式");
    }

    private static void reply(String msg) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.player != null) {
            mc.player.sendSystemMessage(Component.literal("§d[小喵战斗]§r " + msg));
        }
    }
}
