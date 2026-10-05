package com.mew.backpack;

import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.client.renderer.RenderPipelines;
import net.minecraft.network.chat.Component;
import net.minecraft.world.entity.player.Inventory;

/**
 * 小喵背包界面：原版玩家背包(inventory)背景 + 主手黄框高亮 + 副手/盔甲空槽图标。
 */
public class BackpackScreen extends AbstractContainerScreen<BackpackMenu> {

    public BackpackScreen(BackpackMenu menu, Inventory playerInv, Component title) {
        super(menu, playerInv, title);
    }

    @Override
    public void extractBackground(GuiGraphicsExtractor gui, int mouseX, int mouseY, float partialTick) {
        super.extractBackground(gui, mouseX, mouseY, partialTick);
        // 画原版 inventory 背景纹理（照 InventoryScreen 字节码）
        gui.blit(RenderPipelines.GUI_TEXTURED, INVENTORY_LOCATION,
                leftPos, topPos, 0.0f, 0.0f, imageWidth, imageHeight, 256, 256);
    }

    @Override
    protected void extractLabels(GuiGraphicsExtractor gui, int mouseX, int mouseY) {
        // 标题（绝对坐标）
        gui.text(this.font, this.title, this.leftPos + 8, this.topPos + 6, 0x404040, false);
        // 主手高亮：快捷栏选中格画黄色边框
        int sel = this.menu.getSelectedSlot();
        int x = this.leftPos + 8 + sel * 18;
        int y = this.topPos + 142;
        int c = 0xFFFFFF00; // ARGB 黄色
        gui.fill(RenderPipelines.GUI_TEXTURED, x, y, x + 16, y + 1, c);       // 上
        gui.fill(RenderPipelines.GUI_TEXTURED, x, y + 15, x + 16, y + 16, c); // 下
        gui.fill(RenderPipelines.GUI_TEXTURED, x, y, x + 1, y + 16, c);       // 左
        gui.fill(RenderPipelines.GUI_TEXTURED, x + 15, y, x + 16, y + 16, c); // 右
    }
}
