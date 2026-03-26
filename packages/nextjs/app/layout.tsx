import "@rainbow-me/rainbowkit/styles.css";
import "@scaffold-ui/components/styles.css";
import { ScaffoldEthAppWithProviders } from "~~/components/ScaffoldEthAppWithProviders";
import { ThemeProvider } from "~~/components/ThemeProvider";
import "~~/styles/globals.css";

export const metadata = {
  title: "ZK LLM API — Private AI via ZK Proofs",
  description: "Private LLM API access via ZK proofs. No account. No API key. Just a proof.",
  openGraph: {
    title: "ZK LLM API — Private AI via ZK Proofs",
    description: "Private LLM API access via ZK proofs. No account. No API key. Just a proof.",
    images: [{ url: "https://v2.zkllmapi.com/thumbnail.jpg" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "ZK LLM API — Private AI via ZK Proofs",
    description: "Private LLM API access via ZK proofs. No account. No API key. Just a proof.",
    images: ["https://v2.zkllmapi.com/thumbnail.jpg"],
  },
};

const ScaffoldEthApp = ({ children }: { children: React.ReactNode }) => {
  return (
    <html suppressHydrationWarning className={``}>
      <body>
        <ThemeProvider enableSystem>
          <ScaffoldEthAppWithProviders>{children}</ScaffoldEthAppWithProviders>
        </ThemeProvider>
      </body>
    </html>
  );
};

export default ScaffoldEthApp;
