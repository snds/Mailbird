import { useUi } from "@/app/ui-store"

/**
 * "Add an account…", from a section's account list and the command menu
 * (brief X1). It will open the provider list (brief T1); until the accounts
 * lane builds that, it opens Settings › Accounts, where accounts are added
 * today.
 */
export function startAddAccount() {
  useUi.getState().openSettings("accounts")
}

/**
 * "Add account" for someone with none yet, from Mail's empty state (brief
 * M1). It will start first run at its first step (brief X8); until then it
 * opens Settings › Accounts too.
 */
export function startFirstRun() {
  useUi.getState().openSettings("accounts")
}
