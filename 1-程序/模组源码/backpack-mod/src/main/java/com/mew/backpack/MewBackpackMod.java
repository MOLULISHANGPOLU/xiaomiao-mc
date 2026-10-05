package com.mew.backpack;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.player.UseEntityCallback;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.SimpleContainer;
import net.minecraft.world.SimpleMenuProvider;
import net.minecraft.world.entity.player.Inventory;

/**
 * 小喵背包面板（纯服务端模组）。
 * 玩家 shift+右键 LittleMew → 打开一个原版大箱子 GUI（9x5=45 格），
 * 其中前 41 格映射 LittleMew 的背包（36 主背包 + 4 盔甲 + 1 副手），
 * 可拖动管理（拿走 / 放入 / 整理）。客户端零改动。
 */
public class MewBackpackMod implements ModInitializer {
    /** 目标客户端玩家名（LittleMew 的登录名） */
    public static final String TARGET_NAME = "LittleMew";

    @Override
    public void onInitialize() {
        UseEntityCallback.EVENT.register((player, world, hand, entity, hitResult) -> {
            // 只处理：打开者是服务端玩家、目标是服务端玩家 LittleMew、且按了 shift（潜行键）
            if (player instanceof ServerPlayer opener
                    && entity instanceof ServerPlayer target
                    && opener.isShiftKeyDown()
                    && TARGET_NAME.equals(target.getName().getString())) {
                openBackpack(opener, target);
                return InteractionResult.SUCCESS; // 消费事件，取消默认的「交换副手」等行为
            }
            return InteractionResult.PASS;
        });
    }

    private void openBackpack(ServerPlayer opener, ServerPlayer target) {
        Inventory targetInv = target.getInventory();
        SimpleContainer container = new SimpleContainer(41);
        // 快照 41 格：0-35 主背包+快捷栏，36-39 盔甲（脚/腿/胸/头），40 副手
        for (int i = 0; i <= 40; i++) {
            container.setItem(i, targetInv.getItem(i).copy());
        }

        Component title = Component.literal(target.getName().getString() + " 的背包");
        opener.openMenu(new SimpleMenuProvider(
                (syncId, openerInv, p) -> new BackpackMenu(syncId, openerInv, container, targetInv),
                title));
    }
}
