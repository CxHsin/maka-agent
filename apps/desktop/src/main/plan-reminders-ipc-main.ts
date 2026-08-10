/**
 * @deprecated Plan reminders are unified into ScheduledTask.
 * Kept as a no-op module so any residual import fails loudly at typecheck.
 * Registration lives in runtime-host-boot via registerScheduledTaskIpc + plans:* aliases.
 */

export {};
