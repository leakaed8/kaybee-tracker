// In-memory implementation of the same store interface sheetsStore.js
// exposes (listTasks/insertTask/updateTask/batchUpdateTasks/getState/
// setState). Used only by tests, so carry-over logic can be verified
// without any network call or Google credentials.

const crypto = require("crypto");

function createMemoryStore() {
  const tasks = new Map();
  const state = new Map();

  async function listTasks() {
    return Array.from(tasks.values()).map((t) => ({ ...t }));
  }

  async function insertTask(fields) {
    const task = { id: `t${crypto.randomUUID()}`, ...fields };
    tasks.set(task.id, task);
    return { ...task };
  }

  async function updateTask(id, patch) {
    const existing = tasks.get(id);
    if (!existing) return null;
    const merged = { ...existing, ...patch };
    tasks.set(id, merged);
    return { ...merged };
  }

  async function batchUpdateTasks(updates) {
    const results = [];
    for (const { id, patch } of updates) {
      results.push(await updateTask(id, patch));
    }
    return results;
  }

  async function getState(key) {
    return state.has(key) ? state.get(key) : null;
  }

  async function setState(key, value) {
    state.set(key, value);
  }

  return { listTasks, insertTask, updateTask, batchUpdateTasks, getState, setState };
}

module.exports = { createMemoryStore };
