# Diagram renderer fixtures

`specs.json` holds diagram specs; `<n>.html` is what the Node renderer (`src/lib/diagram-renderer.js`) made of spec
`n`. The Rust renderer (`src/lib/diagram_renderer.rs`) must make the same page, character for character. They were
written by:

```bash
node -e 'const fs = require("fs"); const dir = "tests/fixtures/diagram";
import("./src/lib/diagram-renderer.js").then(m => JSON.parse(fs.readFileSync(dir + "/specs.json", "utf8"))
  .forEach((s, i) => fs.writeFileSync(dir + "/" + i + ".html", m.renderDiagramHtml(s))));'
```
