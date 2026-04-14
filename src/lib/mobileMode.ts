const MOBILE_BREAKPOINT = 900;

export const shouldUseMobileApp = () => {
  if (typeof window === 'undefined') return false;
  if (window.zennotesDesktop?.isDesktop) return false;

  const params = new URLSearchParams(window.location.search);
  if (params.get('desktop') === '1') return false;
  if (params.get('mobile') === '1') return true;

  const userAgent = navigator.userAgent.toLowerCase();
  const hasCapacitor = Boolean((window as Window & { Capacitor?: unknown }).Capacitor);
  const isHandheld = /android|iphone|ipad|ipod/.test(userAgent);

  return hasCapacitor || isHandheld || window.innerWidth <= MOBILE_BREAKPOINT;
};
