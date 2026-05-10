# Ethereum Address Converter 🔐

A secure, client-side web application to convert a BIP-39 mnemonic or an Ethereum private key to a public address. This tool is designed with security as a top priority—**all cryptographic operations run exclusively in your browser**. No sensitive data is ever transmitted to a server.

## ✨ Key Features

- ✅ **Client-Side Only**: All cryptographic processes, including key derivation, run securely within your browser.
- ✅ **Mnemonic & Private Key Support**: Accepts both BIP-39 mnemonic phrases (12 or 24 words) and standard 64-character hexadecimal private keys.
- ✅ **Multi-Network Support**: Seamlessly switch between Ethereum Mainnet and a variety of testnets, including Sepolia, Holesky, and others.
- ✅ **Real-Time Balance Checker**: Instantly check the ETH balance of any derived or pasted address.
- ✅ **ERC20 Token Support**: In addition to ETH, you can check balances for any ERC20 token by providing the contract address.
- ✅ **Direct Explorer Integration**: One-click links to verify addresses and transactions on Etherscan or other relevant block explorers.
- ✅ **Modern UI/UX**: A clean, responsive interface with a default dark theme and a convenient light/dark mode toggle.
- ✅ **Built-in Security Warnings**: Clear, persistent warnings to educate users on security best practices.
- ✅ **QR Code Support**: Generate a QR code for your public address for easy sharing.

## 🚀 Installation and Setup

### Prerequisites

- **Node.js**: Version 18.17.0 or higher.
- **Package Manager**: npm, Yarn, or pnpm (pnpm is recommended).

### Steps

1.  **Clone the Repository**

    ```bash
    git clone https://github.com/your-username/ethereum-address-converter.git
    cd ethereum-address-converter
    ```

2.  **Install Dependencies**

    Choose your preferred package manager:

    ```bash
    # Using pnpm (recommended)
    pnpm install

    # Using npm
    npm install

    # Using Yarn
    yarn install
    ```

3.  **Set Up Environment Variables**

    This project uses environment variables to manage Explorer endpoints for different networks. Copy the example file to create your local configuration:

    ```bash
    cp .env.example .env.local
    ```

    Now, edit the `.env.local` file and add routescan URLs.

    ```env
    # to allow pnpm build (standard environment configuration for vercel production)
    PNPM_APPROVE_BUILD=true

    # Mainnet Explorer
    NEXT_PUBLIC_ROUTESCAN_MAINNET=https://routescan.io

    # Testnet Explorer
    NEXT_PUBLIC_ROUTESCAN_TESTNET=https://testnet.routescan.io

    ```

4.  **Run the Development Server**

    ```bash
    npm run dev
    ```

    The application will be accessible at `http://localhost:3000`.

## 📖 Usage Guide

### From Mnemonic

1.  Navigate to the application.
2.  Select the desired network (e.g., Mainnet, Sepolia).
3.  Paste your 12 or 24-word mnemonic phrase into the input field.
4.  Click **"Convert to Address"**.
5.  The corresponding public address will be displayed, along with a button to check its ETH balance.

### From Private Key

1.  Navigate to the application.
2.  Select the desired network.
3.  Paste your 64-character hexadecimal private key (the `0x` prefix is optional).
4.  Click **"Convert to Address"**.
5.  The public address will be displayed. You can reveal or hide your private key using the toggle button.

### Checking Balances

-   **ETH Balance**: After an address is generated, click **"Check Balance"** to see its ETH balance.
-   **ERC20 Token Balance**: To check a token balance, paste the token's contract address into the appropriate field and click the check button.
-   **Verify on Explorer**: Click the **"View on Explorer"** link to open the address on a block explorer like Etherscan for the selected network.

## 🛠️ Development

### Available Scripts

This project uses `npm` scripts for common development tasks:

-   `npm run dev`: Starts the Next.js development server.
-   `npm run build`: Builds the application for production.
-   `npm run start`: Starts a production server.
-   `npm run lint`: Lints the codebase using ESLint to identify and report on patterns.

### Project Structure

The project is organized as follows:

```
.
├── components/         # Reusable React components
│   ├── ui/             # UI elements (buttons, inputs, etc.)
│   └── ...
├── lib/                # Core logic and utilities
│   ├── ethers.ts       # Ethereum provider, balance checks, and contract logic
│   └── ...
├── app/                # Next.js App Router pages
│   ├── page.tsx        # Main application page
│   └── layout.tsx      # Root layout
├── public/             # Static assets
├── .env.local          # Local environment variables
├── next.config.js      # Next.js configuration
└── package.json        # Project dependencies and scripts
```

### Key Dependencies

-   **Framework**: [Next.js](https://nextjs.org/) 14
-   **UI Library**: [React](https://reactjs.org/) 18
-   **Language**: [TypeScript](https://www.typescriptlang.org/)
-   **Styling**: [Tailwind CSS](https://tailwindcss.com/)
-   **Animations**: [Framer Motion](https://www.framer.com/motion/)
-   **Ethereum Interaction**: [Ethers.js](https://ethers.io/) v6
-   **Icons**: [Lucide React](https://lucide.dev/)

## 🔒 Security and Privacy

### ⚠️ IMPORTANT: Read Before Using

1.  **Client-Side Operation**: This application is designed to be completely client-side. **No private keys or mnemonics are ever sent to any server.**
2.  **No Data Storage**: The application does not store your sensitive information in `localStorage`, cookies, or any other persistent storage.
3.  **Secure Environment**: Only use this application on a trusted, malware-free device and a secure network.
4.  **Do Not Share Keys**: Never share your private key or mnemonic phrase with anyone, including the developers of this application.
5.  **Verify the URL**: Always ensure you are on the correct, official URL before entering any sensitive information.
6.  **Use HTTPS**: If deploying this application, ensure it is served over HTTPS to prevent man-in-the-middle attacks.

### Best Practices

-   ✅ Use this tool for address derivation and verification, not for signing transactions.
-   ✅ For significant funds, always use a hardware wallet.
-   ✅ Double-check the address on a block explorer before sending any funds.
-   ✅ Keep offline, encrypted backups of your mnemonics and private keys.

## 🌐 Deployment

This Next.js application is optimized for deployment on platforms like Vercel or Netlify.

### Deploy with Vercel (Recommended)

1.  Push your code to a Git repository (GitHub, GitLab, etc.).
2.  [Import the project](https://vercel.com/new) into Vercel.
3.  Vercel will automatically detect it as a Next.js project.
4.  Add your environment variables from `.env.local` to the Vercel project settings.
5.  Click **Deploy**. Your application will be live in minutes.

### Deploy with Netlify

1.  Push your code to a Git repository.
2.  [Import the project](https://app.netlify.com/start) into Netlify.
3.  Configure the build settings (usually auto-detected for Next.js).
4.  Add your environment variables.
5.  Deploy.

## 📝 License

This project is licensed under the **MIT License**. Feel free to use, modify, and distribute it for personal and commercial purposes. See the [`LICENSE`](/LICENSE) file for more details.

## 🤝 Contributing

Contributions are welcome! If you have suggestions or find a bug, please:

1.  Fork the repository.
2.  Create a new feature branch (`git checkout -b feature/NewFeature`).
3.  Make your changes and commit them (`git commit -m 'Add NewFeature'`).
4.  Push to the branch (`git push origin feature/NewFeature`).
5.  Open a **Pull Request**.

## ⚠️ Disclaimer

This application is provided "AS IS" and without any warranty of any kind. The developer is not responsible for any loss of funds, private keys, or any other damages that may result from the use of this software. **Use at your own risk and always exercise extreme caution with your cryptographic keys.**
