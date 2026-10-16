# Menu

Dropdown menus, context menus and plain popovers, which share one floating surface: `color-modal`, `shadow-large`, `radius-2xl` and 4px padding.

## What you provide

- A trigger, usually a secondary or transparent button with `aria-haspopup="menu"`.
- A `gr-popover` with `role="menu"`, opened 4px from the trigger, holding `gr-menu-item` rows (`role="menuitem"`).
- Optional `gr-menu-group` headings, `gr-menu-sep` separators, `gr-menu-check` columns for checkable items and `gr-menu-shortcut` hints.
- `gr-menu-item-danger` for destructive items, always last and after a separator.

## Rules

- Items are 32px tall with 8px padding and `radius-lg`, which nests inside the 12px popover.
- Context menus open at the pointer; dropdowns align to the trigger's start edge.
- A popover that isn't a menu (a filter form, a date picker) uses the same `gr-popover` surface with 12px padding.
- Enter animation: opacity and scale 0.95 to 1 over 150ms with `ease-out-quint`, origin at the trigger.
