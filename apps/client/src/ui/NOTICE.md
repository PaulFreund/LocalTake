# Adopted UI source

LocalTake uses Vue, Tailwind CSS and shadcn-vue on reka-ui. The [components](components),
the patterns `OptionSelect`, `Disclosure` and `StatusBadge`, and [lib/utils.ts](lib/utils.ts)
were adapted through a shared UI package from the MIT-licensed shadcn-vue `new-york-v4`
registry at [source commit dd3ff4c](https://github.com/unovue/shadcn-vue/tree/dd3ff4ccbb46a15081e841570e51a5a2ace095cf/apps/v4/registry/new-york-v4/ui).
[shadcn-source.json](licenses/shadcn-source.json) lists the adopted files and upstream blobs.
The [upstream license](licenses/shadcn-vue.txt) accompanies the adapted sources. Changes
include local imports, defined-prop forwarding for strict optional types, translated
screen-reader labels and sidebar persistence through the consumer instead of a cookie.

The theme tokens in [styles.css](../styles.css) follow the official shadcn neutral theme;
its [MIT license](licenses/shadcn.txt) accompanies them.
