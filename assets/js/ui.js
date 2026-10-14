// ===== Dialog keyboard navigation =====
// Native dialogs handle background inertness and focus restoration. Explicit
// wrapping keeps Tab within the dialog rather than visiting browser chrome.
document.addEventListener('keydown', handleDialogTab);

function handleDialogTab(event) {
  if (event.key !== 'Tab') return;
  const dialogs = Array.from(document.querySelectorAll('dialog[open]'));
  const dialog = dialogs[dialogs.length - 1];
  if (!dialog) return;
  const controls = Array.from(
    dialog.querySelectorAll('button, input, textarea, select, a[href], summary, [tabindex]')
  ).filter(
    (control) => !control.disabled && control.tabIndex >= 0 && control.getClientRects().length
  );
  if (!controls.length) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (
    event.shiftKey &&
    (document.activeElement === first || !dialog.contains(document.activeElement))
  ) {
    event.preventDefault();
    last.focus();
  } else if (
    !event.shiftKey &&
    (document.activeElement === last || !dialog.contains(document.activeElement))
  ) {
    event.preventDefault();
    first.focus();
  }
}
