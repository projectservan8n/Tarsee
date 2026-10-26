/**
 * File Manager — browse, view, edit workspace files.
 */
const FileManager = {
  currentPath: ".",
  openFile: null,

  init() {
    document.getElementById("fileManagerBtn")?.addEventListener("click", () => this.toggle());
    document.getElementById("fmClose")?.addEventListener("click", () => this.close());
    document.getElementById("fmCloseEditor")?.addEventListener("click", () => this.closeEditor());
    document.getElementById("fmClosePreview")?.addEventListener("click", () => this.closePreview());
    document.getElementById("fmSaveBtn")?.addEventListener("click", () => this.saveFile());
    document.getElementById("fmNewFile")?.addEventListener("click", () => this.newFile());
    // Escape closes a preview, then the panel. Never an open editor: there
    // is no unsaved-changes tracking, so that would silently drop edits.
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const panel = document.getElementById("fileManagerPanel");
      if (!panel || panel.style.display === "none") return;
      const preview = document.getElementById("fmPreview");
      const editor = document.getElementById("fmEditor");
      if (editor && editor.style.display !== "none") return;
      e.preventDefault();
      if (preview && preview.style.display !== "none") this.closePreview();
      else this.close();
    });
  },

  toggle() {
    const panel = document.getElementById("fileManagerPanel");
    if (panel.style.display === "none") {
      panel.style.display = "flex";
      this.loadDir(".");
    } else {
      this.close();
    }
  },

  close() {
    document.getElementById("fileManagerPanel").style.display = "none";
  },

  async loadDir(dirPath) {
    this.currentPath = dirPath;
    const breadcrumb = document.getElementById("fmBreadcrumb");
    breadcrumb.textContent = dirPath === "." ? "workspace" : dirPath;
    breadcrumb.title = dirPath;

    const list = document.getElementById("fmFileList");
    try {
      const data = await API.json(`/api/files/ls?path=${encodeURIComponent(dirPath)}`);
      const items = data.items || [];

      // Sort: dirs first, then files alphabetically
      items.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      let html = "";

      // Back button if not at root
      if (dirPath !== ".") {
        const parent = dirPath.includes("/") ? dirPath.split("/").slice(0, -1).join("/") || "." : ".";
        html += `<div class="fm-item fm-dir" data-path="${parent}" data-action="dir">
          <span class="fm-icon">${this.folderIcon()}</span>
          <span class="fm-name">..</span>
        </div>`;
      }

      for (const item of items) {
        const fullPath = dirPath === "." ? item.name : `${dirPath}/${item.name}`;
        if (item.name.startsWith(".") && item.name !== ".claude") continue; // Hide dotfiles except .claude

        if (item.isDirectory) {
          html += `<div class="fm-item fm-dir" data-path="${this.escapeHtml(fullPath)}" data-action="dir">
            <span class="fm-icon">${this.folderIcon()}</span>
            <span class="fm-name">${this.escapeHtml(item.name)}</span>
          </div>`;
        } else {
          const icon = this.getFileIcon(item.name);
          const size = item.size ? this.formatSize(item.size) : "";
          html += `<div class="fm-item fm-file" data-path="${this.escapeHtml(fullPath)}" data-action="file">
            <span class="fm-icon">${icon}</span>
            <span class="fm-name">${this.escapeHtml(item.name)}</span>
            <span class="fm-size">${size}</span>
          </div>`;
        }
      }

      list.innerHTML = html;

      // Event listeners
      list.querySelectorAll("[data-action='dir']").forEach(el => {
        el.addEventListener("click", () => this.loadDir(el.dataset.path));
      });
      list.querySelectorAll("[data-action='file']").forEach(el => {
        el.addEventListener("click", () => this.openFileView(el.dataset.path));
      });
    } catch (err) {
      list.innerHTML = `<div class="fm-error">${this.escapeHtml(err.message)}</div>`;
    }
  },

  async openFileView(filePath) {
    this.openFile = filePath;
    const ext = filePath.split(".").pop().toLowerCase();
    const editable = ["md", "txt", "js", "json", "html", "css", "py", "sh", "yaml", "yml", "toml", "env", "sql", "ts", "jsx", "tsx", "conf", "cfg", "ini", "xml", "csv"].includes(ext);
    const isImage = ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"].includes(ext);

    if (isImage) {
      // Preview image
      document.getElementById("fmEditor").style.display = "none";
      document.getElementById("fmPreview").style.display = "flex";
      document.getElementById("fmPreviewFilename").textContent = filePath.split("/").pop();
      document.getElementById("fmPreviewContent").innerHTML = `<img src="/api/files/download?path=${encodeURIComponent(filePath)}" class="fm-preview-img">`;
      return;
    }

    try {
      const data = await API.json(`/api/files/read?path=${encodeURIComponent(filePath)}`);

      if (editable) {
        document.getElementById("fmPreview").style.display = "none";
        document.getElementById("fmEditor").style.display = "flex";
        document.getElementById("fmEditorFilename").textContent = filePath.split("/").pop();
        document.getElementById("fmEditorContent").value = data.content;
      } else {
        document.getElementById("fmEditor").style.display = "none";
        document.getElementById("fmPreview").style.display = "flex";
        document.getElementById("fmPreviewFilename").textContent = filePath.split("/").pop();
        document.getElementById("fmPreviewContent").innerHTML = `<pre class="fm-preview-code">${this.escapeHtml(data.content)}</pre>`;
      }
    } catch (err) {
      App.showToast("Can't open: " + err.message, "error");
    }
  },

  async saveFile() {
    if (!this.openFile) return;
    const content = document.getElementById("fmEditorContent").value;
    try {
      await API.json("/api/files/write", { method: "POST", body: { path: this.openFile, content } });
      App.showToast("Saved", "success");
    } catch (err) {
      App.showToast("Save failed: " + err.message, "error");
    }
  },

  async newFile() {
    // (The folder shown when it was pressed is where it goes, whatever the page did while it was asked.)
    const dir = this.currentPath;
    const name = await TarseeDialog.askText({ title: "New file", label: "File name", yes: "Create", no: "Cancel" });
    if (!name) return;
    const filePath = dir === "." ? name : `${dir}/${name}`;
    try {
      await API.json("/api/files/write", { method: "POST", body: { path: filePath, content: "" } });
      this.loadDir(this.currentPath);
      App.showToast("Created " + name, "success");
    } catch (err) {
      App.showToast(err.message, "error");
    }
  },

  closeEditor() {
    document.getElementById("fmEditor").style.display = "none";
    this.openFile = null;
  },

  closePreview() {
    document.getElementById("fmPreview").style.display = "none";
    this.openFile = null;
  },

  /** A file's mark in the list: a plain line drawing of a page (no emoji in the UI), its type in its title. */
  getFileIcon(name) {
    const ext = String(name).includes(".") ? name.split(".").pop().toLowerCase() : "";
    return `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 1.5h5l3.5 3.5v9a1 1 0 01-1 1h-7.5a1 1 0 01-1-1v-11.5a1 1 0 011-1z" stroke="currentColor" stroke-width="1.2"/><path d="M9 1.5V5h3.5" stroke="currentColor" stroke-width="1.2"/></svg>${ext ? `<span class="sr-only">${this.escapeHtml(ext)} file</span>` : ""}`;
  },

  /** A folder's mark in the list. */
  folderIcon() {
    return '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.75 4a1 1 0 011-1h3.5l1.5 1.5h5.5a1 1 0 011 1v6.75a1 1 0 01-1 1h-10.5a1 1 0 01-1-1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  },

  formatSize(bytes) {
    if (bytes < 1024) return bytes + "B";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + "KB";
    return (bytes / 1024 / 1024).toFixed(1) + "MB";
  },

  escapeHtml(text) {
    // Quote-safe: used inside data-path attributes. Mirrors chat.js escapeHtml.
    return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  },
};
