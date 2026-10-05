package com.mew.fight;

import de.maxhenkel.voicechat.api.VoicechatApi;
import de.maxhenkel.voicechat.api.VoicechatClientApi;
import de.maxhenkel.voicechat.api.VoicechatPlugin;
import de.maxhenkel.voicechat.api.events.EventRegistration;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.PlayerInfo;

import java.util.Collection;
import java.util.UUID;

/**
 * 语音就绪提示：把 mewfight 注册成 voicechat 插件，拿到 VoicechatClientApi，
 * 轮询「人类玩家」（服务器里游戏名不是 LittleMew 的第一个人）的语音通道，
 * 通道一通就在聊天框发提示，让用户不用干等 voicechat 那 9~37 秒的建连延迟。
 * 玩家 UUID 运行时动态获取，源码与成品 jar 里不写死任何人的账号标识。
 */
public class VoicechatReadyPlugin implements VoicechatPlugin {

    /** 小喵身体的游戏名（与 config.json players.bot 对应；改名需重新编译模组） */
    private static final String BOT_NAME = "LittleMew";

    private static VoicechatClientApi clientApi;
    private static boolean prompted = false;

    @Override
    public String getPluginId() {
        return "mewfight_voice_ready";
    }

    @Override
    public void initialize(VoicechatApi api) {
        // 客户端下传进来的是 VoicechatClientApi 实例
        if (api instanceof VoicechatClientApi c) {
            clientApi = c;
        }
    }

    @Override
    public void registerEvents(EventRegistration registration) {
        // 不注册事件，检测逻辑靠 MewFightMod.tick 每帧轮询
    }

    /** 由 MewFightMod.tick 每 tick 调用，与战斗开关无关。 */
    static void poll() {
        if (clientApi == null) {
            return;
        }
        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null || mc.getConnection() == null) {
            return;
        }
        // 找人类玩家（在线列表里第一个名字不是 LittleMew 的人），拿他此刻的 UUID
        Collection<PlayerInfo> infos = mc.getConnection().getOnlinePlayers();
        UUID target = null;
        if (infos != null) {
            for (PlayerInfo pi : infos) {
                if (pi == null || pi.getProfile() == null) continue;
                String n = pi.getProfile().name();          // authlib 7 起 GameProfile 是 Record，用 name()/id()
                if (n != null && !n.equals(BOT_NAME)) {
                    target = pi.getProfile().id();
                    break;
                }
            }
        }
        if (target == null) {
            return; // 服务器里只有 LittleMew（或还没进服），没什么可提示的
        }
        // false = 已连接语音（人类玩家的语音通道已通到 LittleMew）
        boolean connected = !clientApi.isDisconnected(target);
        if (connected && !prompted) {
            prompted = true;
            mc.getConnection().sendChat("语音就绪，可以说话啦");
        } else if (!connected) {
            prompted = false; // 断开后重置，下次再连再提示一次
        }
    }
}
