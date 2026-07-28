# OpenTUI with React for the terminal interface

Prtisan uses OpenTUI's native renderer with its React binding for the
Project/Conversation interface. Its Bun-native runtime, responsive layout,
keymap, input, scrolling, Markdown, diff, and test primitives fit the required
agent UI better than assembling those widgets around a line-oriented renderer.
The trade-off is accepting a native dependency and coupling screen components
to OpenTUI's rendering model.
