# Bergamot Translator

Fork of [bergamot-translator](https://github.com/Tuoris/bergamot-translator) which supports just `en` ↔ `uk` translations with wasm worker.

## How to use

1. Install node v18 or later.
2. Download the latest release archive: [bergamot-translator-uken.zip](https://github.com/Tuoris/bergamot-translator/releases/download/v1.0.0/bergamot-translator-uken.zip)
3. Extract files from the release archive.
4. Navigate to the directory with extracted files.
5. Run and type something in ukrainian:

```bash
node index.js
```

6. To run `en` to `uk` translation - update `files` in `index.js` (replace `uken` with `enuk`)
