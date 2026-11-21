// A custom `@formatjs/cli extract --format` plugin: flattens the extracted
// `{ id: { defaultMessage } }` shape into the plain `{ id: defaultMessage }`
// map ADR 0004's own `packages/i18n/locales/en.json` catalog is — the
// English catalog is generated from the source's own `defaultMessage`s, sorted
// for a stable diff; only Italian (and any later language) is hand-translated.
export function format(messages) {
  const flat = {};
  for (const id of Object.keys(messages).sort()) {
    flat[id] = messages[id].defaultMessage;
  }
  return flat;
}
