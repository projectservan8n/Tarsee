/**
 * Agents module — Settings registry + Dashboard panel.
 */
const Agents = {
  init() {
    // Settings: Agent registry
    document.getElementById("addAgentBtn")?.addEventListener("click", () => this.showForm());
    document.getElementById("cancelAgentBtn")?.addEventListener("click", () => this.hideForm());
    document.getElementById("saveAgentBtn")?.addEventListener("click", () => this.saveAgent());

    // Dashboard: toggle panel
    document.getElementById("agentsDashBtn")?.addEventListener("click", () => this.togglePanel());
    document.getElementById("agentsPanelClose")?.addEventListener("click", () => this.closePanel());
  },

  // --- Settings: Agent Registry ---

  async loadRegistry() {
    const list = document.getElementById("agentRegistryList");
    if (!list) return;
    try {
      const data = await API.json("/api/agents/registry");
      const agents = data.agents || [];
      if (agents.length === 0) {
        list.innerHTML = '<div style="color:var(--text-muted);font-size:13px">No agents defined. Add one to get started.</div>';
        return;
      }
      const modelLabels = { "claude-opus-4-6": "Opus", "claude-sonnet-4-6": "Sonnet", "claude-haiku-4-5": "Haiku" };
      list.innerHTML = agents.map(a => {
        const iconHtml = a.icon?.startsWith("ph ") ? `<i class="${a.icon}" style="font-size:16px;color:${a.color || 'var(--text)'}"></i>` : `<span style="font-size:16px">${a.icon || "🤖"}</span>`;
        const nick = a.nickname ? ` "${a.nickname}"` : "";
        return `
        <div class="agent-card" style="border-left:3px solid ${a.color || '#666'}">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div style="display:flex;align-items:center;gap:8px">
              ${iconHtml}
              <div>
                <strong>${a.name}</strong>${nick}
                <span style="font-size:11px;color:var(--text-muted);margin-left:4px">${modelLabels[a.model] || a.model}</span>
              </div>
            </div>
            <div style="display:flex;gap:4px">
              <button class="btn btn-sm" data-agent-edit="${a.id}">Edit</button>
              <button class="btn btn-sm" style="color:var(--danger)" data-agent-delete="${a.id}">Delete</button>
            </div>
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">${(a.prompt || "").slice(0, 80)}...</div>
        </div>
      `}).join("");

      list.querySelectorAll("[data-agent-edit]").forEach(btn => {
        btn.addEventListener("click", () => this.editAgent(btn.dataset.agentEdit));
      });
      list.querySelectorAll("[data-agent-delete]").forEach(btn => {
        btn.addEventListener("click", () => this.deleteAgent(btn.dataset.agentDelete));
      });
    } catch {
      list.innerHTML = "";
    }
  },

  showForm(agent) {
    document.getElementById("agentForm").style.display = "block";
    if (agent) {
      document.getElementById("agentIdInput").value = agent.id;
      document.getElementById("agentIdInput").disabled = true;
      document.getElementById("agentNameInput").value = agent.name;
      document.getElementById("agentNicknameInput").value = agent.nickname || "";
      document.getElementById("agentModelInput").value = agent.model;
      document.getElementById("agentPromptInput").value = agent.prompt;
      document.getElementById("agentIconInput").value = agent.icon || "";
      document.getElementById("agentColorInput").value = agent.color || "#4caf50";
    } else {
      document.getElementById("agentIdInput").value = "";
      document.getElementById("agentIdInput").disabled = false;
      document.getElementById("agentNameInput").value = "";
      document.getElementById("agentNicknameInput").value = "";
      document.getElementById("agentModelInput").value = "claude-sonnet-4-6";
      document.getElementById("agentPromptInput").value = "";
      document.getElementById("agentIconInput").value = "🤖";
      document.getElementById("agentColorInput").value = "#4caf50";
    }
  },

  hideForm() {
    document.getElementById("agentForm").style.display = "none";
  },

  async editAgent(id) {
    const data = await API.json("/api/agents/registry");
    const agent = (data.agents || []).find(a => a.id === id);
    if (agent) this.showForm(agent);
  },

  async deleteAgent(id) {
    try {
      await API.json(`/api/agents/registry/${id}`, { method: "DELETE" });
      App.showToast("Agent removed", "success");
      this.loadRegistry();
    } catch (err) {
      App.showToast(err.message, "error");
    }
  },

  async saveAgent() {
    const agent = {
      id: document.getElementById("agentIdInput").value.trim(),
      name: document.getElementById("agentNameInput").value.trim(),
      nickname: document.getElementById("agentNicknameInput").value.trim() || "",
      model: document.getElementById("agentModelInput").value,
      prompt: document.getElementById("agentPromptInput").value.trim(),
      icon: document.getElementById("agentIconInput").value.trim() || "🤖",
      color: document.getElementById("agentColorInput").value,
      tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    };
    if (!agent.id || !agent.name) {
      App.showToast("ID and Name required", "error");
      return;
    }
    try {
      await API.json("/api/agents/registry", { method: "POST", body: agent });
      App.showToast("Agent saved", "success");
      this.hideForm();
      this.loadRegistry();
    } catch (err) {
      App.showToast(err.message, "error");
    }
  },

  // --- Dashboard Panel ---

  togglePanel() {
    const panel = document.getElementById("agentsPanel");
    if (panel.style.display === "none") {
      panel.style.display = "flex";
      this.loadDashboard();
      this._pollTimer = setInterval(() => this.loadDashboard(), 3000);
    } else {
      this.closePanel();
    }
  },

  closePanel() {
    document.getElementById("agentsPanel").style.display = "none";
    clearInterval(this._pollTimer);
  },

  async loadDashboard() {
    try {
      // Load team roster (always online)
      const regData = await API.json("/api/agents/registry");
      const teamEl = document.getElementById("agentsTeam");
      const agents = regData.agents || [];

      const data = await API.json("/api/agents/tasks");
      const running = data.running || [];
      const history = data.history || [];

      // Find which agents are currently busy
      const busyAgentIds = new Set(running.filter(t => t.status === "running").map(t => t.agentId));

      const modelLabels = { "claude-opus-4-6": "Opus", "claude-sonnet-4-6": "Sonnet", "claude-haiku-4-5": "Haiku" };
      teamEl.innerHTML = agents.map(a => {
        const busy = busyAgentIds.has(a.id);
        const isOrch = a.isOrchestrator;
        const statusDot = isOrch ? '<span class="agent-dot online"></span>' : busy ? '<span class="agent-dot busy"></span>' : '<span class="agent-dot available"></span>';
        const statusText = isOrch ? "Active" : busy ? "Working" : "Available";
        const nick = a.nickname ? ` "${a.nickname}"` : "";
        const iconHtml = a.icon?.startsWith("ph ") ? `<i class="${a.icon}" style="font-size:18px;color:${a.color || 'var(--text)'}"></i>` : `<span style="font-size:16px">${a.icon || "🤖"}</span>`;
        const modelLabel = modelLabels[a.model] || a.model || "";
        return `<div class="agent-team-member" style="border-left:3px solid ${a.color || '#666'}">
          ${iconHtml}
          <div style="flex:1;min-width:0">
            <div style="font-size:13px"><strong>${a.name}</strong>${nick}</div>
            <div style="font-size:11px;color:var(--text-muted);display:flex;align-items:center;gap:6px">${statusDot} ${statusText} · ${modelLabel}</div>
          </div>
        </div>`;
      }).join("") || '<div style="color:var(--text-muted);font-size:13px">No agents configured.</div>';

      const runningEl = document.getElementById("agentsRunning");
      const historyEl = document.getElementById("agentsHistory");

      if (running.length === 0 && history.length === 0) {
        runningEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px;text-align:center">No active tasks. Agents are standing by.</div>';
        historyEl.innerHTML = "";
        return;
      }

      runningEl.innerHTML = running.map(a => `
        <div class="agent-task-card ${a.status}">
          <div class="agent-task-header">
            <span>${a.icon || "🤖"} <strong>${a.name}</strong></span>
            <span class="agent-task-status ${a.status}">${a.status === "running" ? "🟡 Running" : a.status === "completed" ? "✅ Done" : a.status === "failed" ? "❌ Failed" : "⏹ Stopped"}</span>
          </div>
          <div class="agent-task-detail">${a.task}</div>
          ${a.status === "running" ? `<div class="agent-task-meta">${a.toolsUsed} tools · ${a.lastTool ? "Last: " + a.lastTool : ""}</div>` : ""}
          ${a.resultPreview ? `<div class="agent-task-result">${a.resultPreview}</div>` : ""}
        </div>
      `).join("");

      historyEl.innerHTML = history.length > 0 ? "<h3 style='margin:12px 0 8px;font-size:12px;color:var(--text-muted);text-transform:uppercase'>Recent</h3>" +
        history.slice(0, 10).map(a => `
          <div class="agent-task-card ${a.status}" style="opacity:0.7">
            <div class="agent-task-header">
              <span>${a.name}</span>
              <span class="agent-task-status ${a.status}">${a.status}</span>
            </div>
            <div class="agent-task-detail" style="font-size:12px">${(a.task || "").slice(0, 80)}</div>
          </div>
        `).join("") : "";
    } catch {
      /* ignore */
    }
  },
};
