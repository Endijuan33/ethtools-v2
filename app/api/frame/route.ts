export const dynamic = 'force-dynamic';

export async function GET() {
  const miniappEmbed = JSON.stringify({
    version: "1",
    imageUrl: "https://ethtools.vercel.app/placeholder-logo.png",
    buttons: [
      {
        title: "Open App",
        action: {
          type: "launch_miniapp",
          url: "https://ethtools.vercel.app",
          name: "EthTools",
          splashImageUrl: "https://ethtools.vercel.app/placeholder-logo.png",
          splashBackgroundColor: "#eeccff"
        }
      },
      {
        title: "GitHub",
        action: {
          type: "link",
          url: "https://github.com/endijuan33"
        }
      }
    ]
  });

  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EthTools MiniApp</title>

  <!-- Farcaster Mini App Embed (PRIMARY) -->
  <meta name="fc:miniapp" content='${miniappEmbed}' />

  <!-- Legacy Frames v1 Fallback (MUST use name, not property) -->
  <meta name="fc:frame" content="vNext" />
  <meta name="fc:frame:image" content="https://ethtools.vercel.app/placeholder-logo.png" />
  <meta name="fc:frame:image:aspect_ratio" content="1.91:1" />
  <meta name="fc:frame:button:1" content="Open App" />
  <meta name="fc:frame:button:1:action" content="link" />
  <meta name="fc:frame:button:1:target" content="https://ethtools.vercel.app" />
  <meta name="fc:frame:button:2" content="GitHub" />
  <meta name="fc:frame:button:2:action" content="link" />
  <meta name="fc:frame:button:2:target" content="https://github.com/endijuan33" />

  <!-- OpenGraph (still uses property) -->
  <meta property="og:title" content="EthTools MiniApp" />
  <meta property="og:description" content="Tools for Ethereum users" />
  <meta property="og:image" content="https://ethtools.vercel.app/placeholder-logo.png" />
</head>
<body>
  <h1>Welcome to EthTools</h1>
  <p>Open this in Warpcast for the full Mini App experience.</p>
</body>
</html>`,
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=300"
      },
    }
  );
}
