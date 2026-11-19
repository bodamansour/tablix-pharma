// Google's sign-in button, alone in its own small page inside a frame on the sign-in page.
// Google's button script adds its own inline styles to the page it runs in, and they change with Google's
// versions, so a fixed hash in the app's Content-Security-Policy stopped matching. Here, in a page with no
// data and no other script, inline styles are allowed; the app's pages keep their strict policy. The
// credential goes to the page that holds the frame, on this same site only.
const params = new URLSearchParams(location.search);
const clientId = params.get('client') || '';
const text = ['signin_with', 'continue_with', 'signup_with'].includes(params.get('text')) ? params.get('text') : 'signin_with';
const tell = (msg) => { if (parent !== window) parent.postMessage({ type: 'tablix-google', ...msg }, location.origin); };

if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(clientId)) tell({ error: 'config' });
else {
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onerror = () => tell({ error: 'load' });
  s.onload = () => {
    window.google.accounts.id.initialize({ client_id: clientId, callback: ({ credential }) => tell({ credential }) });
    window.google.accounts.id.renderButton(document.getElementById('button'), { theme: 'outline', size: 'large', text, locale: 'ar', width: 280 });
    tell({ ready: true });
  };
  document.head.append(s);
}
