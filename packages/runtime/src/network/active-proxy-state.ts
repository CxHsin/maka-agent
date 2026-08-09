import type { ProxySettings } from '@maka/core';

let activeProxy: ProxySettings | null = null;

export function setActiveProxy(proxy: ProxySettings | null): void {
  activeProxy = proxy?.enabled ? proxy : null;
}

export function resolveActiveProxy(): ProxySettings | null {
  return activeProxy;
}
