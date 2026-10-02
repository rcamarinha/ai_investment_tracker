/**
 * spend/accounts.js — account CRUD.
 *
 * Accounts exist so imports can be scoped: dedupe is per account, cross-bank
 * transfers need two distinct accounts to pair, and MB WAY needs to know which
 * account funds it before it can enrich rather than duplicate.
 */

import state from './state.js?v=3.56.4';
import { escapeHTML, showToast, showConfirm, openModal, closeModal, accountColour } from './utils.js?v=3.56.4';
import { normalizeCurrencyCode } from '../services/money-core.js';
import { saveAccount, deleteAccount } from './storage.js?v=3.56.4';
import { renderAll } from './ledger.js?v=3.56.4';

const el = id => document.getElementById(id);

export function showAccountDialog(accountId = null) {
    state.editingAccountId = accountId;
    const a = accountId ? state.accounts.find(x => x.id === accountId) : null;

    // Only real accounts can fund a wallet, and nothing can fund itself.
    const fundingOptions = state.accounts
        .filter(x => x.type !== 'wallet' && x.id !== accountId)
        .map(x => `<option value="${x.id}" ${a?.linkedAccountId === x.id ? 'selected' : ''}>${escapeHTML(`${x.bankName} · ${x.label}`)}</option>`)
        .join('');

    el('accountDialogTitle').textContent = a ? 'Edit account' : 'Add account';
    el('accountDialogBody').innerHTML = `
        <div class="form-group">
            <label class="form-label">Bank</label>
            <input class="form-input" id="acctBank" placeholder="Millennium bcp" value="${escapeHTML(a?.bankName || '')}">
        </div>
        <div class="form-group">
            <label class="form-label">Label</label>
            <input class="form-input" id="acctLabel" placeholder="Main current account" value="${escapeHTML(a?.label || '')}">
        </div>
        <div class="form-group">
            <label class="form-label" for="acctCurrency">Currency</label>
            <input class="form-input" id="acctCurrency" style="max-width:120px"
                   value="${escapeHTML(a?.currency || 'EUR')}" placeholder="EUR">
            <span class="form-helper" style="display:block">The currency this account is held in. Every conversion downstream uses it.</span>
        </div>
        <div class="form-group">
            <label class="form-label">Type</label>
            <select class="form-select" id="acctType" onchange="spendOnAccountTypeChange()">
                ${['checking', 'savings', 'card', 'wallet'].map(t =>
                    `<option value="${t}" ${a?.type === t ? 'selected' : ''}>${t === 'wallet' ? 'wallet (MB WAY, PayPal)' : t}</option>`).join('')}
            </select>
        </div>
        <div class="form-group" id="acctLinkedGroup" style="display:${a?.type === 'wallet' ? 'block' : 'none'}">
            <label class="form-label">Funded by</label>
            <select class="form-select" id="acctLinked">
                <option value="">—</option>${fundingOptions}
            </select>
            <span class="form-helper">
                A wallet's movements also appear on the funding account's statement.
                Linking them lets an import improve those descriptions instead of duplicating the rows.
            </span>
        </div>
        ${a ? `<button class="btn btn-sm btn-danger" onclick="spendDeleteAccount()" style="margin-top:8px">Delete account</button>
               <span class="form-helper">Deleting an account removes its transactions too.</span>` : ''}`;
    openModal('accountDialog');
}

export function onAccountTypeChange() {
    const group = el('acctLinkedGroup');
    if (group) group.style.display = el('acctType').value === 'wallet' ? 'block' : 'none';
}

/**
 * The account to save, from what the form says and what the account already is.
 *
 * Pure, and separate from the form, because the save is an UPSERT of the whole
 * row: anything this object does not carry is written as its default. The first
 * version hard-coded `currency: 'EUR'` with no field to set it, so editing a
 * GBP or USD account — including a card account the import created in another
 * currency — silently re-denominated it, and currency drives every conversion
 * downstream. It also recoloured the account on every edit and un-archived an
 * archived one. A field the form does not show is CARRIED OVER, never defaulted.
 *
 * @param {{bankName: string, label: string, type: string, currency: string, linkedAccountId: string|null}} form
 * @param {object|null} existing the account being edited, or null for a new one
 * @param {number} accountCount for the colour of a new account
 * @returns {object|string} the account to save, or why it was refused
 */
export function accountFromForm(form, existing = null, accountCount = 0) {
    const bankName = String(form.bankName ?? '').trim();
    const label = String(form.label ?? '').trim();
    if (!bankName || !label) return 'Bank and label are both required.';

    const typed = String(form.currency ?? '').trim();
    const norm = typed ? normalizeCurrencyCode(typed) : null;
    if (typed && !norm) return `"${typed}" is not a currency code — use three letters, like EUR or GBP.`;
    const type = form.type || existing?.type || 'checking';

    return {
        ...(existing?.id ? { id: existing.id } : {}),
        bankName,
        label,
        type,
        currency: norm ? norm.iso : (existing?.currency || 'EUR'),
        linkedAccountId: type === 'wallet' ? (form.linkedAccountId || null) : null,
        // Carried over, not recomputed: the dot colour is how the ledger says
        // which account a row came from, and it should not change on an edit.
        colour: existing?.colour || accountColour(bankName + label, accountCount),
        archived: !!existing?.archived,
        // Learned statement references belong to the account, not to this form.
        ...(existing?.statementRefs ? { statementRefs: existing.statementRefs } : {}),
    };
}

export async function submitAccount() {
    const existing = state.editingAccountId
        ? state.accounts.find(x => x.id === state.editingAccountId) || { id: state.editingAccountId }
        : null;
    const account = accountFromForm({
        bankName: el('acctBank').value,
        label: el('acctLabel').value,
        type: el('acctType').value,
        currency: el('acctCurrency')?.value,
        linkedAccountId: el('acctLinked')?.value || null,
    }, existing, state.accounts.length);

    if (typeof account === 'string') { showToast(account, 'warning'); return; }

    try {
        await saveAccount(account);
        closeModal('accountDialog');
        showToast('Account saved.');
        renderAll();
    } catch (err) { showToast('Could not save account: ' + err.message, 'error'); }
}

export async function removeAccount() {
    const id = state.editingAccountId;
    if (!id) return;
    const count = state.transactions.filter(t => t.accountId === id).length;
    const ok = await showConfirm(
        count ? `Delete this account and its ${count} transaction${count === 1 ? '' : 's'}? This cannot be undone.`
              : 'Delete this account?',
        { danger: true, confirmLabel: 'Delete' });
    if (!ok) return;
    try {
        await deleteAccount(id);
        closeModal('accountDialog');
        showToast('Account deleted.');
        renderAll();
    } catch (err) { showToast('Could not delete: ' + err.message, 'error'); }
}
