// Settings. The Supabase details are the SAME as the courtesy-cars app, so staff use one login.
// From Supabase: Project Settings > API Keys. The publishable (or legacy anon) key is safe to be public.
// Never put the secret or service_role key here.
window.STOCK_CONFIG = {
  supabaseUrl: 'https://qxkyxbtywkczjpqifxwo.supabase.co',
  supabaseAnonKey: 'sb_publishable_tDtj09Zowjrzvj0S9LO8Bg_jZgUAcTm',

  // The web address the QR labels point to. Set this BEFORE printing labels, and don't change it after,
  // or every label needs reprinting. Leave blank to use whatever address the app is opened on.
  appUrl: 'https://japex-stock.netlify.app/',

  // Public key for phone alerts, made with tools/make-keys.html. Leave blank until you set up alerts.
  vapidPublicKey: ''
};
