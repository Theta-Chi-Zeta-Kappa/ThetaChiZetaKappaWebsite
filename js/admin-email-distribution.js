(function(){
  "use strict";

  const panel = document.getElementById("emailDistributionLists");
  if (!panel) return;
  const auth = window.TCZKAdminAuth;
  const endpoint = "/api/admin/email-distribution";
  const form = panel.querySelector("form");
  const message = panel.querySelector("[role=status]");
  const recipients = form.querySelector("tbody");
  const testLink = panel.querySelector("[data-router-test]");
  const settings = form.elements;
  let revision;
  let systemAdmin = false;

  function addRecipient(member = {name:"", email:"", enabled:true}) {
    const row = panel.querySelector("template").content.firstElementChild.cloneNode(true);
    const [name, email, enabled] = row.querySelectorAll("input");
    name.value = member.name;
    email.value = member.email;
    enabled.checked = member.enabled;
    row.querySelector("button").addEventListener("click", () => row.remove());
    recipients.append(row);
  }

  function showHistory(selector, records, describe) {
    const list = panel.querySelector(selector);
    const items = records.map(record => {
      const item = document.createElement("li");
      item.textContent = describe(record);
      return item;
    });
    if (!items.length) {
      const item = document.createElement("li");
      item.textContent = "No records yet.";
      items.push(item);
    }
    list.replaceChildren(...items);
  }

  async function load() {
    const data = await auth.api(endpoint);
    const {config} = data;
    revision = data.revision;
    settings.list.options[0].textContent = config.name;
    settings.address.value = config.address;
    settings.relay.value = config.relay;
    settings.enabled.checked = config.enabled;
    settings.senderCopy.checked = config.ccSender;
    settings.retention.value = config.retentionDays;
    settings.senders.value = config.allowedSenders.join("\n");
    recipients.replaceChildren();
    config.recipients.forEach(addRecipient);
    showHistory("[data-router-status-list]", data.status, record =>
      new Date(record.created_at * 1000).toLocaleString() + " · " + record.state.replaceAll("-", " ") + " · " + record.recipients + " recipients"
    );
    showHistory("[data-router-audit-list]", data.audit, record =>
      new Date(record.created_at.replace(" ", "T") + "Z").toLocaleString() + " · Revision " + record.revision + " · Administrator " + record.actor_id
    );
    testLink.hidden = !config.enabled || !config.allowedSenders.includes(auth.storedUser()?.email?.toLowerCase());
    testLink.href = "mailto:" + config.relay + "?subject=TCZK%20BOD%20relay%20test";
    form.hidden = false;
  }

  panel.querySelector("[data-router-add]").addEventListener("click", () => {
    if (recipients.rows.length < 20) addRecipient();
  });
  panel.querySelector("[data-router-refresh]").addEventListener("click", async () => {
    try {
      await load();
      message.textContent = "";
    } catch (error) {
      message.textContent = error.message;
    }
  });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    const save = settings.save;
    save.disabled = true;
    try {
      const membership = Array.from(recipients.rows, row => {
        const [name, email, enabled] = row.querySelectorAll("input");
        return {name:name.value.trim(), email:email.value.trim(), enabled:enabled.checked};
      });
      const body = {revision, recipients:membership};
      if (systemAdmin) {
        Object.assign(body, {
          enabled:settings.enabled.checked,
          ccSender:settings.senderCopy.checked,
          allowedSenders:settings.senders.value.split(/\s+/).filter(Boolean),
          retentionDays:Number(settings.retention.value),
        });
      }
      await auth.api(endpoint, {method:"PUT", body:JSON.stringify(body)});
      await load();
      message.textContent = "Distribution settings saved.";
    } catch (error) {
      message.textContent = error.message;
    } finally {
      save.disabled = false;
    }
  });

  const passwordForm = document.getElementById("changeAdminPassword");
  passwordForm?.addEventListener("submit", async event => {
    event.preventDefault();
    const fields = passwordForm.elements;
    fields.updatePassword.disabled = true;
    try {
      await auth.api("/api/auth/password", {
        method:"POST",
        body:JSON.stringify({currentPassword:fields.currentPassword.value,newPassword:fields.newPassword.value}),
      });
      passwordForm.reset();
      auth.clearSession();
      location.assign("/admin/");
    } catch (error) {
      passwordForm.querySelector("[role=status]").textContent = error.message;
    } finally {
      fields.currentPassword.value = "";
      fields.newPassword.value = "";
      fields.updatePassword.disabled = false;
    }
  });

  async function start() {
    const session = await auth.requireAuth();
    if (!session || ![0,1].includes(session.user.priority)) return;
    systemAdmin = session.user.priority === 0;
    for (const field of [settings.enabled, settings.senderCopy, settings.retention, settings.senders]) {
      field.disabled = !systemAdmin;
    }
    panel.hidden = false;
    try {
      await load();
    } catch (error) {
      message.textContent = error.message;
    }
  }
  start();
})();
