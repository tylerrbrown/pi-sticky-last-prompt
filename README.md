# Sticky Last Prompt

The maintained fork of [tangentyh/pi-collections](https://github.com/tangentyh/pi-collections/tree/main/extensions/sticky-last-prompt) ships the fullscreen prompt extension only. Its `> ` preview appears once the entire prompt for the current turn scrolls above the viewport. Click the preview to jump back. It does not log prompts or perform network, filesystem, or subprocess operations at runtime. Regular mode does not install an overlay or patch the renderer.

Use a reviewed full commit SHA from the `deployment` branch in Pi user settings. Do not install the upstream workspace root or the fork's upstream-tracking `main` branch.

Regenerate the committed JavaScript from the repository root with Node 24 (no package install required):

```sh
node --disable-warning=ExperimentalWarning -e "const fs=require('node:fs'); const {stripTypeScriptTypes}=require('node:module'); fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/sticky-last-prompt.js',stripTypeScriptTypes(fs.readFileSync('src/sticky-last-prompt.ts','utf8').replace(/\r\n/g,'\n'),{mode:'transform'}))"
```

The overlay covers one transcript row and uses private Pi fullscreen layout and mouse interfaces. Recheck display, scrolling, and click-to-jump when changing Pi or the extension.
