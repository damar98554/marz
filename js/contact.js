// ===== OWNER CONTACT & BRANDING LINKS =====
// Centralized so every WA / Telegram / TikTok / Logo button (login page + in-app) stays in sync.
(function () {
    const OWNER_WHATSAPP_NUMBER = '087830720530'; // local Indonesian format
    const OWNER_TELEGRAM_USERNAME = 'MARZZNJIR';
    const OWNER_TIKTOK_USERNAME = 'andraapake_a';

    // Brand logo shown next to every "DamarzDev" wordmark (login, sidebar, mobile bar).
    const BRAND_LOGO_URL = 'https://cdn.phototourl.com/free/2026-08-27-c863a936-d9a1-4492-910e-33fdd881eac7.png';
    // Where clicking the logo / the 4th "Website" contact button should go.
    // Edit this to your own storefront/portfolio link — defaults to the WhatsApp chat.
    const OWNER_WEBSITE_URL = '';

    function toWhatsAppUrl(localNumber) {
        // Convert local "0..." format to international "62..." format required by wa.me
        let digits = localNumber.replace(/\D/g, '');
        if (digits.startsWith('0')) digits = '62' + digits.slice(1);
        else if (!digits.startsWith('62')) digits = '62' + digits;
        return 'https://wa.me/' + digits;
    }

    const waUrl = toWhatsAppUrl(OWNER_WHATSAPP_NUMBER);
    const tgUrl = 'https://t.me/' + OWNER_TELEGRAM_USERNAME.replace(/^@/, '');
    const ttUrl = 'https://www.tiktok.com/@' + OWNER_TIKTOK_USERNAME.replace(/^@/, '');
    const webUrl = OWNER_WEBSITE_URL || waUrl;

    function wireUp() {
        document.querySelectorAll('#waLogin, #waApp').forEach(el => el.setAttribute('href', waUrl));
        document.querySelectorAll('#tgLogin, #tgApp').forEach(el => el.setAttribute('href', tgUrl));
        document.querySelectorAll('#ttLogin, #ttApp').forEach(el => el.setAttribute('href', ttUrl));
        document.querySelectorAll('#webLogin, #webApp').forEach(el => el.setAttribute('href', webUrl));

        // Brand logo images (login card, sidebar, mobile bar) + clickable brand wrapper links.
        document.querySelectorAll('.brand-logo-img').forEach(img => img.setAttribute('src', BRAND_LOGO_URL));
        document.querySelectorAll('.brand-link').forEach(el => el.setAttribute('href', webUrl));
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wireUp);
    } else {
        wireUp();
    }
})();
