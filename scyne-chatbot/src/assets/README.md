# Login background

The Login component reads its background from the `public/` folder, not from here.

Drop your photo at:

```
scyne-chatbot/public/login-bg.jpg
```

(JPEG, PNG, or WebP all work — just keep the `.jpg` extension or update `LOGIN_BG_URL` in `src/components/Login.tsx`.)

Recommended dimensions: **2400×1350** (16:9) or wider, ~250–500 KB after compression.

If the JPG is missing, the Login component falls back to `public/login-bg.svg` — a branded gradient that ships with the repo.
