import React from 'react';

// After an update, a page's old files are gone: Vite says so with this event — reload once for the new version.
window.addEventListener('vite:preloadError', (e) => {
  try {
    if (sessionStorage.getItem('addendum:reloaded-for-update')) return;
    sessionStorage.setItem('addendum:reloaded-for-update', '1');
  } catch { return; }
  e.preventDefault();
  window.location.reload();
});
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { ToastProvider } from './components/ui';
import './lib/fonts';
import './index.css';
import { applyButtonSize, applyTextSize } from './lib/textSize';

// This device's text size, before the first paint.
applyTextSize();
applyButtonSize();

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 10_000 } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <App />
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
