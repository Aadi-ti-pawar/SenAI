// SenAI CRM Core Client Application Controller
const API_URL = "http://localhost:8000/api";

// App State
let state = {
    activeTab: "inbox",
    activeFilter: "all",
    searchQuery: "",
    emails: [],
    selectedEmail: null,
    charts: {
        sentiment: null,
        category: null
    }
};

// Initialize App
document.addEventListener("DOMContentLoaded", () => {
    initNavigation();
    initFilterMenu();
    initSearch();
    initPollData();
    initCollapsible();
});

// 1. Navigation Controller (Tabs switching)
function initNavigation() {
    const tabs = document.querySelectorAll(".nav-tab");
    tabs.forEach(tab => {
        tab.addEventListener("click", () => {
            const targetTab = tab.getAttribute("data-tab");
            
            // Set nav active
            tabs.forEach(t => t.classList.remove("active"));
            tab.classList.add("active");
            
            // Set view active
            document.querySelectorAll(".tab-view").forEach(view => {
                view.classList.remove("active");
            });
            
            const targetView = document.getElementById(`view-${targetTab}`);
            if (targetView) {
                targetView.classList.add("active");
            }
            
            state.activeTab = targetTab;
            if (targetTab === "analytics") {
                loadAnalytics();
            } else if (targetTab === "reputation") {
                loadReputation();
            }
        });
    });
}

// 2. Filter menu sidebar controller
function initFilterMenu() {
    const filters = document.querySelectorAll(".filter-tab");
    filters.forEach(filter => {
        filter.addEventListener("click", () => {
            filters.forEach(f => f.classList.remove("active"));
            filter.classList.add("active");
            state.activeFilter = filter.getAttribute("data-filter");
            renderEmailsFeed();
        });
    });
}

// 3. Search Bar controller
function initSearch() {
    const searchInput = document.getElementById("search-input");
    if (searchInput) {
        searchInput.addEventListener("input", (e) => {
            state.searchQuery = e.target.value.toLowerCase().trim();
            renderEmailsFeed();
        });
    }
}

// Collapsible panels handler
function initCollapsible() {
    document.addEventListener("click", (e) => {
        const header = e.target.closest(".collapsible-header");
        if (header) {
            const card = header.closest(".collapsible-card");
            if (card) {
                card.classList.toggle("collapsed");
            }
        }
    });
}

// 4. Polling data loops
function initPollData() {
    // Immediate load
    loadDashboardStats();
    loadEmailsFeed();
    
    // Poll every 5 seconds to show incoming simulated emails in real-time
    setInterval(() => {
        loadDashboardStats();
        loadEmailsFeed(true); // silent background load
    }, 5000);
}

// Fetch dashboardstats counters
async function loadDashboardStats() {
    try {
        const res = await fetch(`${API_URL}/dashboard/stats`);
        if (!res.ok) return;
        const stats = await res.json();
        
        // Update counts
        const allCount = stats.pending + stats.replied + stats.escalated;
        document.getElementById("count-all").textContent = allCount;
        document.getElementById("count-human").textContent = stats.pending;
        document.getElementById("count-replied").textContent = stats.replied;
        document.getElementById("count-escalated").textContent = stats.escalated;
        document.getElementById("count-spam").textContent = stats.spam;
    } catch (err) {
        console.error("Error loading dashboard stats:", err);
    }
}

// Fetch list of emails
async function loadEmailsFeed(silent = false) {
    try {
        const res = await fetch(`${API_URL}/emails`);
        if (!res.ok) return;
        const data = await res.json();
        
        state.emails = data;
        renderEmailsFeed(silent);
    } catch (err) {
        console.error("Error loading emails feed:", err);
    }
}

// Render the list of email cards
function renderEmailsFeed(silent = false) {
    const listFeed = document.getElementById("emails-list-feed");
    if (!listFeed) return;
    
    // Filter logic
    let filtered = state.emails.filter(email => {
        // Tab Filters
        if (state.activeFilter === "human") return email.requires_human === true;
        if (state.activeFilter === "replied") return email.status === "Replied";
        if (state.activeFilter === "escalated") return email.status === "Escalated";
        if (state.activeFilter === "spam") return email.is_spam === true;
        return true; // "all"
    });
    
    // Search query filter
    if (state.searchQuery) {
        filtered = filtered.filter(email => {
            return (email.subject && email.subject.toLowerCase().includes(state.searchQuery)) ||
                   (email.body && email.body.toLowerCase().includes(state.searchQuery)) ||
                   (email.sender && email.sender.toLowerCase().includes(state.searchQuery));
        });
    }
    
    if (filtered.length === 0) {
        listFeed.innerHTML = `
            <div class="empty-workspace-state">
                <i data-lucide="mail-search" style="width: 32px; height: 32px; stroke-width: 1.5px;"></i>
                <p>No matching emails found.</p>
            </div>
        `;
        lucide.createIcons();
        return;
    }
    
    // Avoid resetting full list if it has not changed to prevent scrolling jumps during polling
    const currentActiveCard = document.querySelector(".email-card.active");
    const activeId = currentActiveCard ? currentActiveCard.getAttribute("data-id") : null;

    let feedHtml = "";
    filtered.forEach(email => {
        const isSelected = activeId === email.id || (state.selectedEmail && state.selectedEmail.id === email.id);
        const dateStr = formatTime(email.timestamp);
        
        feedHtml += `
            <div class="email-card ${isSelected ? 'active' : ''}" data-id="${email.id}">
                <div class="card-top">
                    <span class="card-sender">${email.sender.split("@")[0]}</span>
                    <span class="card-time">${dateStr}</span>
                </div>
                <div class="card-subject">${email.subject || '(No Subject)'}</div>
                <div class="card-badges">
                    <span class="tag-badge tag-urgency-${email.urgency.toLowerCase()}">${email.urgency}</span>
                    <span class="tag-badge tag-sentiment-${email.sentiment.toLowerCase()}">${email.sentiment}</span>
                    <span class="tag-badge tag-category">${email.category || 'Triage'}</span>
                </div>
            </div>
        `;
    });
    
    listFeed.innerHTML = feedHtml;
    lucide.createIcons();
    
    // Re-attach card selection click handlers
    const cards = listFeed.querySelectorAll(".email-card");
    cards.forEach(card => {
        card.addEventListener("click", () => {
            cards.forEach(c => c.classList.remove("active"));
            card.classList.add("active");
            const emailId = card.getAttribute("data-id");
            selectEmail(emailId);
        });
    });
}

// 5. Select Email Workspace detail
async function selectEmail(emailId) {
    const workspace = document.getElementById("detail-workspace");
    if (!workspace) return;
    
    workspace.innerHTML = `
        <div class="loading-spinner">
            <div class="spinner"></div>
            <span>Fetching thread details...</span>
        </div>
    `;
    
    const email = state.emails.find(e => e.id === emailId);
    if (!email) return;
    
    try {
        // Fetch thread history & actions
        const res = await fetch(`${API_URL}/threads/${email.sender}`);
        if (!res.ok) {
            throw new Error("Failed to load threads.");
        }
        const threads = await res.json();
        
        // Find matching thread in database
        const activeThread = threads.find(t => t.thread_pk === email.thread_id || t.emails.some(e => e.id === emailId)) || threads[0];
        
        if (!activeThread) {
            workspace.innerHTML = `<div class="empty-workspace-state"><p>Error displaying thread.</p></div>`;
            return;
        }

        // Fetch contact profile
        const contactRes = await fetch(`${API_URL}/contacts/${email.sender}`);
        const contact = contactRes.ok ? await contactRes.json() : null;

        state.selectedEmail = email;
        renderWorkspace(activeThread, contact);
        
    } catch (err) {
        console.error(err);
        workspace.innerHTML = `<div class="empty-workspace-state"><p>Failed to retrieve data from server.</p></div>`;
    }
}

// Render workspace panel details
function renderWorkspace(thread, contact) {
    const workspace = document.getElementById("detail-workspace");
    if (!workspace) return;

    // Highlights dollar amounts and ticket IDs (e.g. SENAI-1234)
    const highlightEntities = (text) => {
        if (!text) return "";
        let highlighted = text.replace(/(\$[0-9,]+(\.[0-9]{2})?)/g, '<span class="highlight-entity">$1</span>');
        highlighted = highlighted.replace(/(SENAI-[A-Za-z0-9]+)/g, '<span class="highlight-entity">$1</span>');
        return highlighted;
    };

    // Render Timeline emails
    let timelineHtml = "";
    thread.emails.forEach(msg => {
        const dateStr = new Date(msg.timestamp).toLocaleString();
        timelineHtml += `
            <div class="email-message-bubble">
                <div class="message-bubble-header">
                    <span>From: <strong>${msg.sender}</strong></span>
                    <span>${dateStr}</span>
                </div>
                <div class="message-bubble-body">${highlightEntities(msg.body)}</div>
            </div>
        `;
    });

    // Extract citations & reasoning from actions
    const latestAction = thread.actions[thread.actions.length - 1] || null;
    const reasoningLog = latestAction && latestAction.agent_reasoning_log ? latestAction.agent_reasoning_log : [];
    const citations = latestAction && latestAction.rag_citations ? latestAction.rag_citations : [];
    
    // Construct Reasoning step items
    let reasoningHtml = "";
    if (reasoningLog && reasoningLog.length > 0) {
        reasoningLog.forEach(step => {
            const actionText = step.action ? `Call ${step.action.tool} (${JSON.stringify(step.action.params)})` : null;
            reasoningHtml += `
                <div class="reasoning-step-item">
                    <div class="step-thought">Thought: ${step.thought}</div>
                    ${actionText ? `<div class="step-action-meta">${actionText}</div>` : ''}
                    ${step.observation ? `<div class="step-observation-meta">Observation: ${JSON.stringify(step.observation)}</div>` : ''}
                </div>
            `;
        });
    } else {
        reasoningHtml = `<span style="font-size:12px; color:var(--text-muted);">No agent reasoning steps recorded.</span>`;
    }

    // Construct Citations items
    let citationsHtml = "";
    if (citations && citations.length > 0) {
        citations.forEach(cit => {
            citationsHtml += `
                <div class="citation-item">
                    <span class="citation-doc">${cit.document} (${cit.section})</span>
                    <span class="citation-score">Sim: ${(cit.similarity * 100).toFixed(1)}%</span>
                </div>
            `;
        });
    } else {
        citationsHtml = `<span style="font-size:12px; color:var(--text-muted);">No policy citations matched.</span>`;
    }

    // Contact card status patching
    const VIP = contact && contact.status === "VIP";
    const BLOCKED = contact && contact.status === "Blocked";
    const statusSelectHtml = `
        <select class="status-select" id="contact-status-dropdown" data-email="${thread.sender_email}">
            <option value="Active" ${contact && contact.status === "Active" ? 'selected' : ''}>Active</option>
            <option value="VIP" ${VIP ? 'selected' : ''}>VIP</option>
            <option value="Blocked" ${BLOCKED ? 'selected' : ''}>Blocked</option>
            <option value="Churned" ${contact && contact.status === "Churned" ? 'selected' : ''}>Churned</option>
        </select>
    `;

    // Action Area draft content
    const draftContent = latestAction ? (latestAction.proposed_content || "") : "";
    const showDraftArea = latestAction && latestAction.action_type === "Draft-Created" && latestAction.execution_status === "Pending";

    workspace.innerHTML = `
        <!-- Header -->
        <div class="workspace-header">
            <div class="thread-meta-info">
                <h2 class="thread-subject">${thread.subject || "(No Subject)"}</h2>
                <div class="thread-meta-row">
                    <span>Thread ID: ${thread.thread_id}</span>
                    <span>Status: <strong style="color:var(--primary);">${thread.status}</strong></span>
                    <span>Priority: <span class="tag-badge tag-urgency-${thread.priority.toLowerCase()}">${thread.priority}</span></span>
                </div>
            </div>
            
            <!-- Contact Card -->
            <div class="contact-profile-card">
                <div class="profile-card-top">
                    <span class="contact-name">${contact ? contact.name || 'Anonymous' : 'Anonymous'}</span>
                    ${statusSelectHtml}
                </div>
                <div class="profile-stats-row">
                    <div class="profile-stat-box">
                        <span class="stat-box-lbl">Value</span>
                        <span class="stat-box-val">$${contact ? contact.account_value.toFixed(2) : '0.00'}</span>
                    </div>
                    <div class="profile-stat-box">
                        <span class="stat-box-lbl">Churn Risk</span>
                        <span class="stat-box-val" style="color:${contact && contact.churn_risk_score >= 0.7 ? 'var(--critical)' : 'var(--text-secondary)'}">
                            ${contact ? (contact.churn_risk_score * 100).toFixed(0) : '0'}%
                        </span>
                    </div>
                </div>
            </div>
        </div>

        <!-- Timeline -->
        <div class="thread-timeline">
            ${timelineHtml}
        </div>

        <!-- Collapsible sections -->
        <div class="collapsible-sections">
            <!-- Agent Reasoning -->
            <div class="collapsible-card collapsed">
                <div class="collapsible-header">
                    <span>Agent Reasoning Trace</span>
                    <i data-lucide="chevron-down"></i>
                </div>
                <div class="collapsible-content">
                    <div class="reasoning-list">${reasoningHtml}</div>
                </div>
            </div>

            <!-- RAG context citations -->
            <div class="collapsible-card collapsed">
                <div class="collapsible-header">
                    <span>RAG Citations Context</span>
                    <i data-lucide="chevron-down"></i>
                </div>
                <div class="collapsible-content">
                    <div class="citations-list">${citationsHtml}</div>
                </div>
            </div>
        </div>

        <!-- Action Workspace response panel -->
        <div class="action-workspace-panel">
            <span class="action-label-row">Operator Response Area</span>
            <textarea class="response-draft-area" id="triage-response-draft" placeholder="Draft a reply to send to the customer...">${draftContent}</textarea>
            <div class="action-buttons-row">
                <div class="action-left-buttons">
                    ${showDraftArea ? `
                        <button class="btn btn-primary" id="btn-approve-draft" data-action-id="${latestAction.id}">
                            <i data-lucide="check"></i> Approve & Send
                        </button>
                    ` : ''}
                    <button class="btn btn-secondary" id="btn-save-draft" data-action-id="${latestAction ? latestAction.id : ''}">
                        <i data-lucide="save"></i> Save Draft
                    </button>
                </div>
                <button class="btn btn-danger" id="btn-action-escalate" data-email-id="${state.selectedEmail.id}">
                    <i data-lucide="share-2"></i> Escalate to Owner
                </button>
            </div>
        </div>
    `;

    lucide.createIcons();

    // Attach listeners inside details workspace
    attachWorkspaceListeners();
}

// Bind clicks on buttons in detail workspace
function attachWorkspaceListeners() {
    // 1. Status patches dropdown
    const statusSelect = document.getElementById("contact-status-dropdown");
    if (statusSelect) {
        statusSelect.addEventListener("change", async (e) => {
            const email = statusSelect.getAttribute("data-email");
            const newStatus = e.target.value;
            try {
                const res = await fetch(`${API_URL}/contacts/${email}/status`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ status: newStatus })
                });
                if (res.ok) {
                    console.log("Contact status patched successfully!");
                }
            } catch (err) {
                console.error("Failed to patch contact status:", err);
            }
        });
    }

    // 2. Save Draft (PATCH)
    const btnSaveDraft = document.getElementById("btn-save-draft");
    if (btnSaveDraft) {
        btnSaveDraft.addEventListener("click", async () => {
            const actionId = btnSaveDraft.getAttribute("data-action-id");
            const draftContent = document.getElementById("triage-response-draft").value;
            if (!actionId) {
                alert("No active draft proposal exists for this email.");
                return;
            }
            try {
                const res = await fetch(`${API_URL}/drafts/${actionId}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ proposed_content: draftContent })
                });
                if (res.ok) {
                    alert("Draft reply saved successfully!");
                    loadEmailsFeed();
                }
            } catch (err) {
                console.error(err);
            }
        });
    }

    // 3. Approve Draft (POST)
    const btnApproveDraft = document.getElementById("btn-approve-draft");
    if (btnApproveDraft) {
        btnApproveDraft.addEventListener("click", async () => {
            const actionId = btnApproveDraft.getAttribute("data-action-id");
            try {
                const res = await fetch(`${API_URL}/drafts/${actionId}/approve`, {
                    method: "POST"
                });
                if (res.ok) {
                    alert("Draft approved and sent successfully!");
                    loadEmailsFeed();
                    // Reload selected email details
                    selectEmail(state.selectedEmail.id);
                }
            } catch (err) {
                console.error(err);
            }
        });
    }

    // 4. Escalate to human (POST)
    const btnEscalate = document.getElementById("btn-action-escalate");
    if (btnEscalate) {
        btnEscalate.addEventListener("click", async () => {
            const emailId = btnEscalate.getAttribute("data-email-id");
            try {
                const res = await fetch(`${API_URL}/respond/${emailId}`, {
                    method: "POST"
                });
                if (res.ok) {
                    alert("Thread successfully escalated to a human owner.");
                    loadEmailsFeed();
                    selectEmail(emailId);
                }
            } catch (err) {
                console.error(err);
            }
        });
    }
}

// 6. Analytics Tab Loading
async function loadAnalytics() {
    try {
        // Stats
        const resStats = await fetch(`${API_URL}/dashboard/stats`);
        const stats = resStats.ok ? await resStats.json() : null;
        if (stats) {
            document.getElementById("stats-total-emails").textContent = stats.pending + stats.replied + stats.escalated;
            document.getElementById("stats-critical-emails").textContent = stats.critical;
            document.getElementById("stats-needs-review").textContent = stats.pending;
            document.getElementById("stats-replied").textContent = stats.replied;
        }

        // Category Breakdown
        const resCat = await fetch(`${API_URL}/analytics/category-breakdown`);
        const catData = resCat.ok ? await resCat.json() : [];

        // Sentiment trend
        const resSent = await fetch(`${API_URL}/analytics/sentiment-trend`);
        const sentData = resSent.ok ? await resSent.json() : [];

        renderAnalyticsCharts(catData, sentData);
        renderAtRiskAccounts();

    } catch (err) {
        console.error("Failed to load analytics dashboard:", err);
    }
}

// Render Chart.js components
function renderAnalyticsCharts(categories, sentiments) {
    // Destroy previous chart instances to prevent rendering overlays
    if (state.charts.sentiment) state.charts.sentiment.destroy();
    if (state.charts.category) state.charts.category.destroy();

    // 1. Sentiment Trend Line Chart
    const sentCtx = document.getElementById("chart-sentiment-trend").getContext("2d");
    const sentLabels = sentiments.map(pt => pt.date);
    const sentScores = sentiments.map(pt => pt.moving_avg_7d || pt.avg_sentiment || 0);

    state.charts.sentiment = new Chart(sentCtx, {
        type: "line",
        data: {
            labels: sentLabels.length > 0 ? sentLabels : ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
            datasets: [{
                label: "7-Day Moving Avg Sentiment",
                data: sentScores.length > 0 ? sentScores : [0.2, 0.45, 0.35, 0.6, 0.55],
                borderColor: "#6366f1",
                backgroundColor: "rgba(99, 102, 241, 0.05)",
                fill: true,
                tension: 0.35,
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { grid: { display: false } },
                y: { min: -1.0, max: 1.0 }
            }
        }
    });

    // 2. Category Breakdown Bar Chart
    const catCtx = document.getElementById("chart-category-breakdown").getContext("2d");
    const catLabels = categories.map(c => c.category);
    const catCounts = categories.map(c => c.count);

    state.charts.category = new Chart(catCtx, {
        type: "bar",
        data: {
            labels: catLabels.length > 0 ? catLabels : ["Inquiry", "Billing", "Bug Report", "Legal"],
            datasets: [{
                data: catCounts.length > 0 ? catCounts : [24, 12, 8, 4],
                backgroundColor: [
                    "rgba(99, 102, 241, 0.65)",
                    "rgba(245, 158, 11, 0.65)",
                    "rgba(16, 185, 129, 0.65)",
                    "rgba(239, 68, 68, 0.65)"
                ],
                borderWidth: 0,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { grid: { display: false } },
                y: { beginAtZero: true }
            }
        }
    });
}

// Fetch at-risk customer accounts
async function renderAtRiskAccounts() {
    const tableBody = document.getElementById("at-risk-accounts-table-body");
    if (!tableBody) return;
    
    // We filter the local list of contact profiles that have churn risk score >= 0.4
    // We can fetch profiles dynamically or find them from the emails list
    let listHtml = "";
    
    // Find unique senders
    const uniqueSenders = [...new Set(state.emails.map(e => e.sender))];
    const profiles = [];
    
    for (const sender of uniqueSenders.slice(0, 5)) {
        try {
            const res = await fetch(`${API_URL}/contacts/${sender}`);
            if (res.ok) {
                profiles.push(await res.json());
            }
        } catch (e) {}
    }
    
    // Sort by risk descending
    profiles.sort((a, b) => b.churn_risk_score - a.churn_risk_score);
    
    if (profiles.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="5" style="text-align:center;">No churn risk accounts detected.</td></tr>`;
        return;
    }
    
    profiles.forEach(prof => {
        const riskColor = prof.churn_risk_score >= 0.7 ? 'var(--critical)' : prof.churn_risk_score >= 0.4 ? 'var(--high)' : 'var(--text-secondary)';
        listHtml += `
            <tr>
                <td style="font-weight:600; color:var(--primary);">${prof.email}</td>
                <td>${prof.company || 'N/A'}</td>
                <td>$${prof.account_value.toFixed(2)}</td>
                <td style="color:${riskColor}; font-weight:700;">${(prof.churn_risk_score * 100).toFixed(0)}%</td>
                <td><span class="badge">${prof.status}</span></td>
            </tr>
        `;
    });
    
    tableBody.innerHTML = listHtml;
}

// 7. Web Intelligence & Reputation Tab Loading
async function loadReputation() {
    try {
        const res = await fetch(`${API_URL}/intelligence/reputation?entity=SenAI`);
        if (!res.ok) return;
        const data = await res.json();
        
        // Update Ratings details
        document.getElementById("reputation-trustpilot-score").textContent = data.Trustpilot.score.toFixed(1);
        document.getElementById("reputation-trustpilot-label").textContent = data.Trustpilot.rating_label;
        document.getElementById("reputation-trustpilot-reviews").textContent = `Based on ${data.Trustpilot.reviews_count} reviews`;

        document.getElementById("reputation-g2-score").textContent = data.G2.score.toFixed(1);
        document.getElementById("reputation-g2-label").textContent = data.G2.rating_label;
        document.getElementById("reputation-g2-reviews").textContent = `Based on ${data.G2.reviews_count} reviews`;

        document.getElementById("reputation-status").textContent = data.source === "crawler" ? "Live Scraped" : "Served from Cache";
        document.getElementById("reputation-last-updated").textContent = new Date(data.Trustpilot.last_updated).toLocaleString();

    } catch (err) {
        console.error("Failed to load reputation scores:", err);
    }
}

// Helper: Formats timestamps relative to today
function formatTime(timestamp) {
    const d = new Date(timestamp);
    const now = new Date();
    
    if (d.toDateString() === now.toDateString()) {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
