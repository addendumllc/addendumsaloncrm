# Design system

Every page in the Command Center uses the same shared components and tokens. A new page, tab, modal or feature
reuses these. If something is genuinely new, extend the shared component rather than styling it for one page.

## Tokens

Colours, fonts, sizes, corners and button sizes are CSS variables. `web/src/lib/theme.ts` sets them from Settings
(Theme Settings, Font Style, Button Style) and each person's own look. Use the Tailwind names that read them:

- **Accent and status:** `plum` (accent), `ink`, `ink-soft`, `stone`, `line`, `mist`, `sage`, `rose`, `amber`.
- **Fonts:** `font-display`, `font-button`, `font-nav`.

Never hard-code a hex colour or a font. Page colours, accents and fonts must come from the theme so customisation
applies everywhere.

## Components (`web/src/components/ui/index.tsx`, `web/src/index.css`)

| Need | Use |
| --- | --- |
| Page title, subtitle, primary action | `PageHeader` (the action goes in `actions`, top right) |
| A section's sub-pages | an entry in `SUB_NAV` (`components/layout/subNav.tsx`), plus `<SectionPicker path=…>` on the page. The sidebar lists them on desktop; tablets get tabs and phones a dropdown. |
| Tabs inside a page or popup | `PageTabs` |
| One-of-a-few switch (Month/Week/Day, grid/list) | `Segmented` |
| Pick one or several (accounts, tags, services, people) | `chipClass(selected)` on a `<button>` |
| Status or label | `Badge` |
| Buttons and button-looking links | `Button` / `buttonClass()` (sizes follow Button Style) |
| Inputs, selects, textareas | `.field`; labels via `Field` |
| Search and filter rows | `.field h-10` controls (search with an icon: `h-10 pl-9`), `Segmented`, `Button size="sm"` |
| Cards and lists | `.panel` (lists: `panel divide-y divide-line !p-0`) |
| Popups | `Modal` (`wide` / `xl`); Cancel and Save in `footer` |
| Loading, empty, error | `PageLoading`, `EmptyState`, `ErrorNote`; toasts via `useToast` |

## Sidebar

- Every row uses `.nav-row`; sub-pages use `.nav-sub` inside `.nav-children`.
- `.is-active` marks the page you're on.
- A section with two or more sub-pages gets the expand chevron. Clicking it opens or closes the section, and opening a
  sub-page keeps it open.
- Don't style sidebar items anywhere else.

## Businesses

Addendum Salon (Square) and Addendum Hair (Shopify) share one design. Pages that show one business's data label it in
the page text; they don't get their own colours or layout.

## Before adding a feature

1. Find the closest existing page or component and follow it.
2. Use the components above, and add a sub-page to `SUB_NAV` instead of building tabs by hand.
3. Check it at phone (375px), tablet (768px) and desktop widths.
