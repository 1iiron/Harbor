import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function harness(chapters, positionSec = 0) {
  const slots = [], effects = [], events = new Map(), seeks = [], changes = [];
  let slot = 0, tree;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const jsx = (type, props) => {
    if (props?.ref) props.ref.current = { contains: node => node === "inside" };
    return { type, props };
  };
  const surface = {
    addEventListener: (name, fn) => events.set(name, fn),
    removeEventListener: (name, fn) => { if (events.get(name) === fn) events.delete(name); },
  };
  const dependencies = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    react: {
      useState: value => { const i = slot++; if (!(i in slots)) slots[i] = value; return [slots[i], next => { slots[i] = next; }]; },
      useRef: value => { const i = slot++; return slots[i] ??= { current: value }; },
      useMemo: fn => fn(), useCallback: fn => fn,
      useEffect: (run, deps) => { const i = slot++; if (!same(slots[i]?.deps, deps)) effects.push(() => {
        slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: run() };
      }); },
    },
    "lucide-react": { ListTree: "list-icon", X: "close-icon" },
    "@/lib/i18n": { useT: () => (text, values) => values ? text.replace("{chapter}", values.chapter) : text },
    "./transport-utils": { fmtTime: value => `${value}s` },
  };
  const source = readFileSync(new URL("../src/components/player/transport/chapter-menu.tsx", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const api = {};
  new Function("require", "exports", "document", "window", code)(id => {
    assert.ok(id in dependencies, `unexpected import ${id}`); return dependencies[id];
  }, api, surface, surface);
  const props = { chapters, positionSec, onSeek: value => seeks.push(value), onOpenChange: value => changes.push(value) };
  const render = () => { slot = 0; tree = api.ChapterMenu(props); effects.splice(0).forEach(fn => fn()); };
  const buttons = () => {
    const result = [];
    const visit = node => { if (Array.isArray(node)) node.forEach(visit); else if (node?.props) {
      if (node.type === "button") result.push(node); visit(node.props.children);
    } };
    visit(tree); return result;
  };
  render();
  return { render, buttons, seeks, changes, events, empty: () => tree === null,
    toggle() { buttons()[0].props.onClick(); render(); },
    unmount() { for (const item of slots) item?.cleanup?.(); },
  };
}

test("chapter menu orders valid chapters and seeks to the selected chapter", () => {
  const h = harness([{ startSec: 60, title: "Second" }, { startSec: NaN }, { startSec: 0, title: "First" }], 65);
  h.toggle();
  const rows = h.buttons().slice(2);
  assert.equal(rows.length, 2);
  assert.match(rows[1].props.className, /bg-white\/12/);
  rows[0].props.onClick(); h.render();
  assert.deepEqual(h.seeks, [0]);
  assert.deepEqual(h.changes, [true, false]);
  assert.equal(h.buttons()[0].props["aria-expanded"], false);
});

test("Escape and outside clicks close chapters and remove listeners", () => {
  const h = harness([{ startSec: 0 }]);
  h.toggle(); h.events.get("pointerdown")({ target: "inside" });
  assert.equal(h.changes.at(-1), true);
  h.events.get("keydown")({ key: "Escape" }); h.render();
  assert.equal(h.events.size, 0);
  h.toggle(); h.events.get("pointerdown")({ target: "outside" }); h.render();
  assert.equal(h.buttons()[0].props["aria-expanded"], false);
  h.toggle(); h.unmount(); assert.equal(h.events.size, 0);
});

test("chapter controls stay hidden without usable chapters", () => {
  assert.equal(harness([]).empty(), true);
  assert.equal(harness([{ startSec: Infinity }]).empty(), true);
});
