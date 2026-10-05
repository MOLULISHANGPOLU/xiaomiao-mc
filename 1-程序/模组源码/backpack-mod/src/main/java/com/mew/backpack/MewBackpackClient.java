package com.mew.backpack;

import net.fabricmc.api.ClientModInitializer;
import net.minecraft.client.gui.screens.MenuScreens;

/**
 * 客户端入口：把 BackpackMenu 绑定到 BackpackScreen。
 * MenuScreens.register 经 fabric-transitive-access-wideners-v1 变 public。
 */
public class MewBackpackClient implements ClientModInitializer {
    @Override
    public void onInitializeClient() {
        MenuScreens.register(BackpackMenu.TYPE, BackpackScreen::new);
    }
}
