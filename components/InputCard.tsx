'use client';

import { useState, useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';

type Network = 'mainnet' | 'testnet';

interface InputCardProps {
  onConvert: (input: string, network: Network) => void;
  isLoading: boolean;
}

export default function InputCard({ onConvert, isLoading }: InputCardProps) {
  const [inputValue, setInputValue] = useState('');
  const [network, setNetwork] = useState<Network>('mainnet');
  const [error, setError] = useState('');

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputValue(e.target.value);
  };

  const handleConvert = () => {
    setError('');
    const trimmedInput = inputValue.trim();
    if (!trimmedInput) {
      setError('Input cannot be empty.');
      return;
    }
    onConvert(trimmedInput, network);
  };

  const { wordCount, charCount } = useMemo(() => {
    const trimmedInput = inputValue.trim();
    const words = trimmedInput.split(/\s+/).filter(Boolean);
    return {
      wordCount: trimmedInput ? words.length : 0,
      charCount: inputValue.length,
    };
  }, [inputValue]);

  const isPrivateKey = wordCount < 12 && charCount > 60;
  const isMnemonic = wordCount === 12 || wordCount === 18 || wordCount === 24;

  return (
    <div className="w-full max-w-md p-6 bg-white/10 backdrop-blur-md rounded-xl shadow-glass border border-white/20">
        <h2 className="text-xl font-bold text-white mb-4 text-center">Private Key / Mnemonic Converter</h2>
        <div className="bg-yellow-500/10 border border-yellow-500 text-yellow-300 text-sm p-3 rounded-lg mb-4 flex">
            <AlertTriangle size={32} className="mr-2 flex-shrink-0" />
            <p><strong>Security Warning:</strong> This tool runs locally in your browser. Your keys are never sent to a server, but always be cautious and do not use on public devices.</p>
        </div>
      <div className="relative mb-4">
        <textarea
          value={inputValue}
          onChange={handleInputChange}
          placeholder="Enter your 12, 18, 24 word mnemonic or a private key..."
          className="w-full h-32 p-3 bg-black/20 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-shadow resize-none"
        />
        <div className="absolute bottom-3 right-3 text-xs text-gray-400">
          {isPrivateKey ? (
            <span className={charCount === 64 || charCount === 66 ? 'text-green-400' : ''}>
              {charCount} / {inputValue.startsWith('0x') ? 66 : 64} chars
            </span>
          ) : (
            <span className={isMnemonic ? 'text-green-400' : ''}>
              {wordCount} / {wordCount < 18 ? 12 : (wordCount < 24 ? 18 : 24)} words
            </span>
          )}
        </div>
      </div>
      {error && <p className="text-red-400 text-sm mt-2">{error}</p>}

      <div className="flex items-center gap-3">
        <div className="flex items-center bg-black/20 p-1 rounded-lg">
            {(['mainnet', 'testnet'] as Network[]).map((net) => (
                <button
                    key={net}
                    onClick={() => setNetwork(net)}
                    className={`px-4 py-2 rounded-md text-sm font-semibold capitalize transition-colors ${
                        network === net
                        ? 'bg-blue-600 text-white'
                        : 'text-gray-300 hover:bg-white/10'
                    }`}
                >
                    {net}
                </button>
            ))}
        </div>
        <button
            onClick={handleConvert}
            disabled={isLoading || !inputValue.trim()}
            className="flex-grow w-full bg-green-600 text-white font-bold py-3 px-4 rounded-lg hover:bg-green-700 transition-colors disabled:bg-gray-500 disabled:cursor-not-allowed"
        >
            {isLoading ? 'Converting...' : 'Convert'}
        </button>
      </div>
    </div>
  );
}
