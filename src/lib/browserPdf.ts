const PRINT_FRAME_ID = 'zennotes-print-frame';

const removePrintFrame = () => {
  document.getElementById(PRINT_FRAME_ID)?.remove();
};

const waitForImages = async (documentRef: Document) => {
  const pendingImages = Array.from(documentRef.images).filter(image => !image.complete);
  if (pendingImages.length === 0) return;

  await Promise.race([
    Promise.allSettled(
      pendingImages.map(image => new Promise<void>((resolve) => {
        image.addEventListener('load', () => resolve(), { once: true });
        image.addEventListener('error', () => resolve(), { once: true });
      })),
    ),
    new Promise<void>(resolve => window.setTimeout(resolve, 1500)),
  ]);
};

export const printHtmlAsPdf = async (html: string) => new Promise<void>((resolve, reject) => {
  if (typeof document === 'undefined') {
    reject(new Error('Tarayici yazdirma ortami bulunamadi.'));
    return;
  }

  removePrintFrame();

  const blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }));

  const iframe = document.createElement('iframe');
  iframe.id = PRINT_FRAME_ID;
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '1px';
  iframe.style.height = '1px';
  iframe.style.border = '0';
  iframe.style.opacity = '0';
  iframe.style.pointerEvents = 'none';

  let didTriggerPrint = false;

  const cleanup = () => {
    window.clearTimeout(fallbackCleanupId);
    URL.revokeObjectURL(blobUrl);
    removePrintFrame();
  };

  const fallbackCleanupId = window.setTimeout(cleanup, 60_000);

  const triggerPrint = async () => {
    if (didTriggerPrint) return;
    didTriggerPrint = true;

    const frameWindow = iframe.contentWindow;
    const frameDocument = iframe.contentDocument;
    if (!frameWindow) {
      cleanup();
      reject(new Error('PDF yazdirma cercevesi hazirlanamadi.'));
      return;
    }

    try {
      if (frameDocument) {
        await waitForImages(frameDocument);
        if (frameDocument.fonts?.ready) {
          await frameDocument.fonts.ready.catch(() => {});
        }
      }
    } catch {
      // Print akisi yine de devam etsin.
    }

    const handleAfterPrint = () => {
      frameWindow.removeEventListener('afterprint', handleAfterPrint);
      cleanup();
    };

    frameWindow.addEventListener('afterprint', handleAfterPrint, { once: true });

    window.setTimeout(() => {
      try {
        frameWindow.focus();
        frameWindow.print();
        resolve();
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error('Tarayici yazdirma islemi baslatilamadi.'));
      }
    }, 180);
  };

  iframe.onload = () => {
    void triggerPrint();
  };

  iframe.onerror = () => {
    cleanup();
    reject(new Error('Tarayici yazdirma sayfasi olusturulamadi.'));
  };

  iframe.src = blobUrl;
  document.body.appendChild(iframe);
});
