package com.mew.backpack;

import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.Container;
import net.minecraft.world.SimpleContainer;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.flag.FeatureFlagSet;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.ContainerData;
import net.minecraft.world.inventory.InventoryMenu;
import net.minecraft.world.inventory.MenuType;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.ItemStack;

/**
 * 小喵背包菜单：按原版玩家背包（InventoryMenu）的布局，一眼看清
 * 主手(快捷栏选中格,黄框高亮)/副手(盾牌位)/盔甲4格(头胸腿脚)。
 * 41 格是 LittleMew 背包的快照，关闭时写回。
 */
public class BackpackMenu extends AbstractContainerMenu {

    /** 注册 MenuType（经 fabric-transitive-access-wideners-v1 变 public 的构造器） */
    public static final MenuType<BackpackMenu> TYPE = Registry.register(
            BuiltInRegistries.MENU,
            Identifier.fromNamespaceAndPath("mewbackpack", "backpack"),
            new MenuType<>(BackpackMenu::new, FeatureFlagSet.of()));

    private final Inventory targetInv;
    private final SimpleContainer container;
    private boolean synced = false;
    private int selectedSlot;

    /** 同步主手(快捷栏选中格)到客户端 */
    private final ContainerData selectedData = new ContainerData() {
        @Override
        public int get(int index) {
            return selectedSlot;
        }

        @Override
        public void set(int index, int value) {
            selectedSlot = value;
        }

        @Override
        public int getCount() {
            return 1;
        }
    };

    /** 客户端构造（MenuType 的 MenuSupplier 指向这里：create(int, Inventory)） */
    public BackpackMenu(int syncId, Inventory playerInv) {
        this(syncId, playerInv, new SimpleContainer(41), null);
    }

    /** 服务端构造 */
    public BackpackMenu(int syncId, Inventory playerInv, SimpleContainer container, Inventory targetInv) {
        super(TYPE, syncId);
        this.targetInv = targetInv;
        this.container = container;
        this.selectedSlot = (targetInv != null) ? targetInv.getSelectedSlot() : 0;
        this.addDataSlots(selectedData);

        // 盔甲 4 格（container 39 头 / 38 胸 / 37 腿 / 36 脚），坐标照 InventoryMenu
        this.addSlot(new IconSlot(container, 39, 8, 8, InventoryMenu.EMPTY_ARMOR_SLOT_HELMET));
        this.addSlot(new IconSlot(container, 38, 8, 26, InventoryMenu.EMPTY_ARMOR_SLOT_CHESTPLATE));
        this.addSlot(new IconSlot(container, 37, 8, 44, InventoryMenu.EMPTY_ARMOR_SLOT_LEGGINGS));
        this.addSlot(new IconSlot(container, 36, 8, 62, InventoryMenu.EMPTY_ARMOR_SLOT_BOOTS));

        // 副手 1 格（container 40）
        this.addSlot(new IconSlot(container, 40, 77, 62, InventoryMenu.EMPTY_ARMOR_SLOT_SHIELD));

        // 主背包 3 行（container 9-35），y = 84 / 102 / 120
        for (int row = 0; row < 3; row++) {
            for (int col = 0; col < 9; col++) {
                this.addSlot(new Slot(container, 9 + row * 9 + col, 8 + col * 18, 84 + row * 18));
            }
        }

        // 快捷栏 1 行（container 0-8），y = 142
        for (int col = 0; col < 9; col++) {
            this.addSlot(new Slot(container, col, 8 + col * 18, 142));
        }
    }

    /** 主手 = 快捷栏选中格（0-8），供客户端画黄框 */
    public int getSelectedSlot() {
        return selectedSlot;
    }

    @Override
    public boolean stillValid(Player player) {
        return true;
    }

    @Override
    public ItemStack quickMoveStack(Player player, int index) {
        Slot slot = this.slots.get(index);
        ItemStack stack = slot.getItem();
        if (stack.isEmpty()) {
            return ItemStack.EMPTY;
        }
        // 在 41 格容器内移到第一个空位（跳过当前槽）
        for (int i = 0; i < this.slots.size(); i++) {
            Slot s = this.slots.get(i);
            if (i != index && s.getItem().isEmpty() && s.mayPlace(stack)) {
                s.set(stack.copy());
                slot.set(ItemStack.EMPTY);
                return ItemStack.EMPTY;
            }
        }
        return ItemStack.EMPTY;
    }

    @Override
    public void removed(Player player) {
        super.removed(player);
        if (targetInv == null || synced) {
            return;
        }
        synced = true;
        // 写回 41 格到小喵背包
        for (int i = 0; i <= 40; i++) {
            targetInv.setItem(i, container.getItem(i).copy());
        }
        targetInv.setChanged();
    }

    /** 带空槽图标的槽位：槽空时显示盔甲/副手对应图标 */
    private static class IconSlot extends Slot {
        private final Identifier icon;

        IconSlot(Container container, int index, int x, int y, Identifier icon) {
            super(container, index, x, y);
            this.icon = icon;
        }

        @Override
        public Identifier getNoItemIcon() {
            return icon;
        }
    }
}
