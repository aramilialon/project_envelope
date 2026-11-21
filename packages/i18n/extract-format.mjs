// A custom `@formatjs/cli extract --format` plugin (`pnpm --filter @envelope/i18n extract`):
// flattens the extracted `{ id: { defaultMessage } }` shape into the plain
// `{ id: defaultMessage }` map ADR 0004's own `locales/en.json` catalog is — the
// English catalog is generated from the source's own `defaultMessage`s, every app's
// sources listed in the `extract` script, sorted for a stable diff; every other
// language is translated by hand.
export function format(messages) {
  const flat = {};
  for (const id of Object.keys(messages).sort()) {
    flat[id] = messages[id].defaultMessage;
  }
  return flat;
}
