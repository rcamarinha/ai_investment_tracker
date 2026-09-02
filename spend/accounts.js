/**
 * spend/accounts.js — account CRUD.
 *
 * Accounts exist so imports can be scoped: dedupe is per account, cross-bank
 * transfers need two distinct accounts to pair, and MB WAY needs to know which
 * account funds it before it can enrich rather than duplicate.
 */

import state from './state.js?v=3.43.0';
import { escapeHTML, showToast, showConfirm, openModal, closeModal, accountColour } from './utils.js?v=3.43.0';
import { saveAccount, deleteAccount } from './storage.js?v=3.43.0';
import { renderAll } from './ledger.js?v=3.43.0';

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

export async function submitAccount() {
    const bankName = el('acctBank').value.trim();
    const label = el('acctLabel').value.trim();
    if (!bankName || !label) { showToast('Bank and label are both required.', 'warning'); return; }

    const type = el('acctType').value;
    const account = {
        ...(state.editingAccountId ? { id: state.editingAccountId } : {}),
        bankName, label, type,
        currency: 'EUR',
        linkedAccountId: type === 'wallet' ? (el('acctLinked')?.value || null) : null,
        colour: accountColour(bankName + label, state.accounts.length)
    };

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
