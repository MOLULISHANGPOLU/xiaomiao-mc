package com.mew.fight;

import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

/**
 * 小喵战斗控制面板：游戏内 GUI，用来调开关 / 半径 / 视线检测，不用改配置文件。
 * 打开方式：聊天敲 /mewfight gui，或按 G 键（可在按键设置里改）。
 */
public class MewFightScreen extends Screen {

    private static final int PANEL_W = 240;
    private static final int PANEL_H = 220;

    public MewFightScreen() {
        super(Component.literal("小喵战斗控制面板"));
    }

    @Override
    protected void init() {
        int x = this.width / 2 - PANEL_W / 2;
        int y = this.height / 2 - PANEL_H / 2;

        addRenderableWidget(Button.builder(
                Component.literal(MewFightMod.isEnabled() ? "§a战斗：已开启" : "§7战斗：已关闭"),
                btn -> {
                    MewFightMod.toggleEnabled();
                    rebuild();
                })
                .bounds(x + 20, y + 32, 200, 20).build());

        addRenderableWidget(Button.builder(
                Component.literal(MewFightMod.isRetaliate() ? "§a受伤还手：开" : "§7受伤还手：关"),
                btn -> {
                    MewFightMod.toggleRetaliate();
                    rebuild();
                })
                .bounds(x + 20, y + 58, 200, 20).build());

        addRenderableWidget(Button.builder(
                Component.literal(MewFightMod.isLineOfSight() ? "§a视线检测：开" : "§7视线检测：关"),
                btn -> {
                    MewFightMod.toggleLineOfSight();
                    rebuild();
                })
                .bounds(x + 20, y + 84, 200, 20).build());

        addRenderableWidget(Button.builder(
                Component.literal("模式：" + ("creative".equals(MewFightMod.getGamemode()) ? "§e创造§r" : "§c生存§r")),
                btn -> {
                    MewFightMod.toggleGamemode();
                    rebuild();
                })
                .bounds(x + 20, y + 110, 200, 20).build());

        addRenderableWidget(Button.builder(
                Component.literal("§c-1 半径"),
                btn -> {
                    MewFightMod.adjustRange(-1);
                    rebuild();
                })
                .bounds(x + 20, y + 136, 95, 20).build());

        addRenderableWidget(Button.builder(
                Component.literal("§a半径 +1"),
                btn -> {
                    MewFightMod.adjustRange(1);
                    rebuild();
                })
                .bounds(x + 125, y + 136, 95, 20).build());

        addRenderableWidget(Button.builder(
                Component.literal("§7关闭面板"),
                btn -> this.onClose())
                .bounds(x + 20, y + 186, 200, 20).build());
    }

    private void rebuild() {
        this.clearWidgets();
        this.init();
    }

    @Override
    public void extractRenderState(GuiGraphicsExtractor g, int mouseX, int mouseY, float partialTick) {
        super.extractRenderState(g, mouseX, mouseY, partialTick);
        int cx = this.width / 2;
        int y = this.height / 2 - PANEL_H / 2;
        g.centeredText(this.font, Component.literal("§d[小喵战斗] 控制面板"), cx, y + 12, 0xFFFFFF);
        g.centeredText(this.font,
                Component.literal("锁定半径：" + (int) MewFightMod.getRange() + " 格（1~64）"),
                cx, y + 162, 0xFFFFFF);
    }

    @Override
    public boolean isPauseScreen() {
        return false; // 打开面板不暂停游戏，小喵继续战斗
    }
}
