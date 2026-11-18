import { stripVTControlCharacters } from "node:util";
import { SkillInvocationMessageComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
const WIDGET_ID = "sticky-last-prompt";
function collapseWhitespace(text) {
    return stripVTControlCharacters(text).replace(/\s+/g, " ").replace(/\p{Cc}/gu, "").trim();
}
function padToWidth(text, width) {
    const pad = width - visibleWidth(text);
    return pad > 0 ? text + " ".repeat(pad) : text;
}
function measureLines(component, width) {
    try {
        const render = component.render;
        return typeof render === "function" ? render.call(component, width)?.length ?? 0 : 0;
    } catch  {
        return 0;
    }
}
function plainContainerChildren(value) {
    if (!(value instanceof Container)) return undefined;
    if (value.render !== Container.prototype.render) return undefined;
    const shared = Container.prototype.renderShared;
    if (shared !== undefined && value.renderShared !== shared) return undefined;
    const children = value.children;
    return Array.isArray(children) ? children : undefined;
}
function collectUserAnchors(children, width, offset, found) {
    for (const child of children){
        if (child instanceof UserMessageComponent) {
            const text = collapseWhitespace(extractUserText(child.text));
            const height = measureLines(child, width);
            if (text) found.push({
                start: offset,
                end: offset + height,
                text
            });
            offset += height;
        } else if (child instanceof SkillInvocationMessageComponent) {
            const name = child.skillBlock?.name;
            const height = measureLines(child, width);
            if (typeof name === "string" && name.trim()) {
                found.push({
                    start: offset,
                    end: offset + height,
                    text: `[skill] ${collapseWhitespace(name)}`
                });
            }
            offset += height;
        } else {
            const nested = plainContainerChildren(child);
            if (nested !== undefined) {
                offset = collectUserAnchors(nested, width, offset, found);
            } else {
                offset += measureLines(child, width);
            }
        }
    }
    return offset;
}
function extractUserText(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const parts = [];
    for (const part of content){
        if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
            parts.push(part.text);
        }
    }
    return parts.join("\n");
}
const EMPTY_COMPONENT = {
    render: ()=>[],
    invalidate: ()=>{}
};
class PinBar {
    getText;
    renderedRows = 0;
    theme;
    constructor(getText){
        this.getText = getText;
    }
    setTheme(theme) {
        this.theme = theme;
    }
    reset() {
        this.theme = undefined;
        this.renderedRows = 0;
    }
    render(width) {
        const theme = this.theme;
        const text = this.getText();
        if (!theme || !text || width < 3) {
            this.renderedRows = 0;
            return [];
        }
        const label = truncateToWidth(text, width - 2, "…");
        const line = `${theme.fg("accent", ">")} ${theme.fg("text", label)}`;
        this.renderedRows = 1;
        return [
            theme.bg("selectedBg", padToWidth(line, width))
        ];
    }
    invalidate() {}
}
export default function stickyLastPrompt(pi) {
    let altScreen;
    let overlay = null;
    const patchedRenderers = new WeakSet();
    let anchorCache = null;
    const bar = new PinBar(()=>currentSelection()?.text ?? "");
    function primaryScrollView() {
        const screen = altScreen;
        if (!screen) return undefined;
        try {
            const direct = screen.getPrimaryScrollView?.();
            if (direct) return direct;
        } catch  {}
        const entries = screen.layoutRoot?.entries;
        const found = entries?.find((entry)=>{
            const component = entry?.component;
            return !!component && component.primary === true;
        });
        return found?.component;
    }
    function terminalWidth() {
        return Math.max(1, altScreen?.terminal.columns ?? 80);
    }
    function userAnchors(sv, width) {
        const contentHeight = sv.contentHeight;
        const docChildren = sv.child?.children;
        const children = Array.isArray(docChildren) ? docChildren : undefined;
        if (anchorCache && anchorCache.width === width && anchorCache.contentHeight === contentHeight && anchorCache.children === children) {
            return anchorCache.anchors;
        }
        const anchors = [];
        if (children) {
            collectUserAnchors(children, width, 0, anchors);
        }
        anchorCache = {
            width,
            contentHeight,
            children,
            anchors
        };
        return anchors;
    }
    function currentSelection() {
        const sv = primaryScrollView();
        if (!sv) return undefined;
        const width = typeof sv.getContentWidth === "function" ? sv.getContentWidth(terminalWidth()) : terminalWidth();
        const anchors = userAnchors(sv, Math.max(1, width));
        const limit = sv.scrollTop;
        let selected;
        for (const anchor of anchors){
            if (anchor.start <= limit) selected = anchor;
            else break;
        }
        if (selected && selected.end > limit) return undefined;
        return selected;
    }
    function tryConsumeClick(event) {
        if (!overlay || overlay.isHidden()) return false;
        if (event.release || (event.button & 32) !== 0 || (event.button & 3) !== 0) return false;
        if (event.y < 0 || event.y >= bar.renderedRows) return false;
        jumpToPinnedMessage();
        return true;
    }
    function jumpToPinnedMessage() {
        const selected = currentSelection();
        if (!selected) return;
        const sv = primaryScrollView();
        if (!sv) return;
        sv.scrollTo(Math.max(0, selected.start - bar.renderedRows), {
            disableFollow: true
        });
        altScreen?.requestRender();
    }
    function installHasOverlayPatch(screen) {
        if (typeof screen.hasOverlay !== "function") return false;
        const originalHasOverlay = screen.hasOverlay.bind(screen);
        const isVisible = (entry)=>{
            try {
                return typeof screen.isOverlayVisible === "function" ? screen.isOverlayVisible(entry) : !entry.hidden;
            } catch  {
                return true;
            }
        };
        screen.hasOverlay = ()=>{
            const stack = screen.overlayStack;
            if (!Array.isArray(stack)) return originalHasOverlay();
            for (const raw of stack){
                const entry = raw;
                if (!isVisible(entry)) continue;
                if (entry.component !== bar) return originalHasOverlay();
            }
            return false;
        };
        return true;
    }
    function installRendererPatches(screen) {
        if (patchedRenderers.has(screen)) return;
        let installed = false;
        if (typeof screen.handleSelectionMouseEvent === "function") {
            installed = true;
            const original = screen.handleSelectionMouseEvent.bind(screen);
            screen.handleSelectionMouseEvent = (event)=>{
                if (tryConsumeClick(event)) return undefined;
                return original(event);
            };
        }
        installed = installHasOverlayPatch(screen) || installed;
        if (installed) patchedRenderers.add(screen);
    }
    function uninstallRendererPatches() {
        const screen = altScreen;
        if (!screen || !patchedRenderers.has(screen)) return;
        delete screen.handleSelectionMouseEvent;
        delete screen.hasOverlay;
        patchedRenderers.delete(screen);
    }
    function syncOverlay() {
        const screen = altScreen;
        if (!screen) return;
        const want = screen.mode === "fullscreen";
        if (want && !overlay) {
            const options = {
                anchor: "top-left",
                row: 0,
                col: 0,
                width: "100%",
                nonCapturing: true
            };
            overlay = screen.showOverlay(bar, options);
        } else if (!want && overlay) {
            overlay.hide();
            overlay = null;
        }
    }
    pi.on("session_start", async (_event, ctx)=>{
        if (ctx.mode !== "tui" || !ctx.hasUI) return;
        anchorCache = null;
        ctx.ui.setWidget(WIDGET_ID, (tui, theme)=>{
            if (tui.mode !== "fullscreen") return EMPTY_COMPONENT;
            const screen = tui;
            altScreen = screen;
            bar.setTheme(theme);
            installRendererPatches(screen);
            syncOverlay();
            return EMPTY_COMPONENT;
        });
    });
    pi.on("session_shutdown", async (_event, ctx)=>{
        if (ctx.mode !== "tui" || !ctx.hasUI) return;
        ctx.ui.setWidget(WIDGET_ID, undefined);
        uninstallRendererPatches();
        overlay?.hide();
        overlay = null;
        altScreen = undefined;
        bar.reset();
        anchorCache = null;
    });
}
