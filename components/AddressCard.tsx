'use client';

import { useState } from 'react';
import { Check, Copy, ExternalLink, RefreshCw } from 'lucide-react';
import { getConverterExplorerUrl } from '@/lib/ethers'; // FIX: Use the correct explorer URL function

interface AddressCardProps {
  address: string;
  network: 'mainnet' | 'testnet';
  onReset: () => void; // Function to go back to the input view
}

export default function AddressCard({ address, network, onReset }: AddressCardProps) {
  const [isCopied, setIsCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(address);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  // FIX: Map the component's 'network' state ('testnet') to the value expected by the function ('sepolia')
  const ethersNetwork = network === 'mainnet' ? 'mainnet' : 'sepolia';
  const routescanUrl = getConverterExplorerUrl(address, ethersNetwork);

  return (
    <div className="w-full max-w-md p-6 bg-white/10 backdrop-blur-md rounded-xl shadow-glass border border-white/20 text-center">
      <h3 className="text-lg font-semibold text-white mb-3">Generated Public Address:</h3>
      <div className="flex items-center justify-between bg-black/20 p-3 rounded-lg">
        <p className="text-md text-green-400 break-all">{address}</p>
        <button onClick={handleCopy} className="ml-2 p-1 text-gray-300 hover:text-white transition-colors">
          {isCopied ? <Check size={20} className="text-green-500" /> : <Copy size={20} />}
        </button>
      </div>
      <a
        href={routescanUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-4 w-full flex items-center justify-center bg-blue-600 text-white font-bold py-3 px-4 rounded-lg hover:bg-blue-700 transition-colors"
      >
        Check on Routescan
        <ExternalLink size={18} className="ml-2" />
      </a>
      <button
        onClick={onReset}
        className="mt-3 w-full flex items-center justify-center bg-gray-600 text-white font-bold py-3 px-4 rounded-lg hover:bg-gray-700 transition-colors"
      >
        <RefreshCw size={18} className="mr-2" />
        Convert Another
      </button>
    </div>
  );
}
