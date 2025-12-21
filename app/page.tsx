'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import InputCard from '@/components/InputCard';
import AddressCard from '@/components/AddressCard';
import GeneratorCard from '@/components/GeneratorCard';
import WalletCard from '@/components/WalletCard'; // Import the new WalletCard component
import FooterCredit from '@/components/FooterCredit';
import { getAddressFromMnemonic, getAddressFromPrivateKey } from '@/lib/ethers';

type Network = 'mainnet' | 'testnet';

export default function Home() {
  const [address, setAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [network, setNetwork] = useState<Network>('mainnet');
  const [activeTab, setActiveTab] = useState('converter');

  const handleConvert = (input: string, selectedNetwork: Network) => {
    setIsLoading(true);
    setError(null);
    setAddress(null);
    setNetwork(selectedNetwork);

    try {
      let derivedAddress;
      if (input.trim().includes(' ')) {
        derivedAddress = getAddressFromMnemonic(input);
      } else {
        derivedAddress = getAddressFromPrivateKey(input);
      }
      setAddress(derivedAddress);
    } catch (e) {
      if (e instanceof Error) {
        setError(e.message);
      } else {
        setError('An unknown error occurred.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleReset = () => {
    setAddress(null);
    setError(null);
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-4 sm:p-8 bg-gray-900 bg-gradient-to-br from-indigo-900/50 to-purple-900/50">
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="text-center mb-8"
      >
        <h1 className="text-4xl md:text-5xl font-bold text-white">Ethereum Wallet Utility</h1>
        <p className="text-lg text-gray-300 mt-2">Secure, client-side Ethereum key tools. Your keys never leave your browser.</p>
      </motion.div>

      {/* Tab Switcher */}
      <div className="w-full max-w-2xl bg-black/20 p-1 rounded-lg flex justify-center space-x-2 mb-6">
        <button
          onClick={() => setActiveTab('converter')}
          className={`w-full py-2 rounded-md font-semibold transition-colors ${activeTab === 'converter' ? 'bg-green-600 text-white' : 'text-gray-300 hover:bg-white/10'}`}>
          Converter
        </button>
        <button
          onClick={() => setActiveTab('generator')}
          className={`w-full py-2 rounded-md font-semibold transition-colors ${activeTab === 'generator' ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-white/10'}`}>
          Generator
        </button>
        <button
          onClick={() => setActiveTab('wallet')}
          className={`w-full py-2 rounded-md font-semibold transition-colors ${activeTab === 'wallet' ? 'bg-purple-600 text-white' : 'text-gray-300 hover:bg-white/10'}`}>
          Wallet
        </button>
      </div>

      <motion.div
        key={activeTab}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5, delay: 0.1 }}
        className="w-full flex justify-center"
      >
        {activeTab === 'converter' ? (
          !address ? (
            <InputCard onConvert={handleConvert} isLoading={isLoading} />
          ) : (
            <AddressCard address={address} network={network} onReset={handleReset} />
          )
        ) : activeTab === 'generator' ? (
          <GeneratorCard />
        ) : (
          <WalletCard />
        )}
      </motion.div>

      {activeTab === 'converter' && error && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="mt-4 text-red-400 font-semibold bg-red-900/50 p-3 rounded-lg w-full max-w-md text-center"
        >
          {`Conversion Failed: ${error}`}
        </motion.div>
      )}

      <FooterCredit />
    </main>
  );
}
