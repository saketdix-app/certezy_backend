# SEO — making pages readable by Google, Bing and AI assistants

The site is a React app: without help, every URL returns the same empty
`index.html`. The API now fills that file in per URL (`src/modules/seo`):

| URL | What crawlers get |
|---|---|
| every page | its own `<title>`, description, canonical link, Open Graph / Twitter tags |
| `/`, `/courses`, `/courses/:slug`, `/about`, `/contact-us`, … | page text (course description, curriculum, links) inside `#root`, plus JSON-LD (`Course`, `Organization`, `BreadcrumbList`, `ItemList`) |
| `/login`, `/student/*`, `/admin/*`, `/checkout`, `/offer/*` | `noindex` |
| unknown pages / missing courses | HTTP 404 + `noindex` (the app still shows its own page) |
| `/sitemap.xml` | home, courses list, every published course, info pages |
| `/robots.txt` | allows Googlebot, Bingbot, GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, PerplexityBot; blocks admin / student / checkout |
| `/llms.txt` | short site summary + course links for AI assistants |

The page text inside `#root` stays invisible for real visitors (React replaces it
as soon as it starts); crawlers that don't run JavaScript read it from the HTML.

## 1. nginx (one-time)

`sudo nano /etc/nginx/nginx.conf` and, inside the `server { … listen 443 ssl … }`
block, **replace** the existing

```nginx
location / {
    try_files $uri $uri/ /index.html;
}
```

with:

```nginx
    # Static files (JS, CSS, images) straight from dist; page URLs → API renderer
    location / {
        try_files $uri @page;
    }

    location @page {
        rewrite ^ /__seo/page break;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Original-URI $request_uri;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # API down? serve the plain app instead of an error page
        proxy_intercept_errors on;
        error_page 502 503 504 = @spa;
    }

    location @spa {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        try_files /index.html =404;
    }

    location = /robots.txt  { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; }
    location = /sitemap.xml { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; }
    location = /llms.txt    { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; }
```

Keep the `location = /index.html { … no-cache … }` and `location /assets/ { … }`
blocks you already added. Then:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

The API finds the built site at `../frontend/dist` (next to the backend folder).
If yours is elsewhere, set `FRONTEND_DIST_DIR=/home/ec2-user/app/frontend/dist`
in the backend `.env`. `SITE_URL` defaults to `https://certezy.com`.

## 2. Check

```bash
curl -s https://certezy.com/courses/pmp | grep -E "<title>|canonical|ld\+json" | head
curl -s https://certezy.com/sitemap.xml | head
curl -s https://certezy.com/robots.txt | head
```

## 3. Tell the search engines

1. **Google Search Console** → add property `certezy.com` (DNS verification) →
   *Sitemaps* → submit `https://certezy.com/sitemap.xml`. Use *URL inspection →
   Request indexing* for the home page and the PMP course.
2. **Bing Webmaster Tools** → import from Search Console (one click) and submit the
   sitemap. ChatGPT search uses Bing's index, so this matters for ChatGPT.
3. Test a course page in Google's **Rich Results Test** (search.google.com/test/rich-results).

Indexing usually takes days to a few weeks. Good course titles and descriptions in
Admin → Courses (they become the Google title and snippet) help the most.
