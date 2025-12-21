'use client';

import { useState } from 'react';
import { Plus, Trash2, Loader2 } from 'lucide-react';
import { getTokenDetails, getTokenBalance, Network } from '@/lib/ethers';
import { isAddress } from 'ethers';

interface Token {
  address: string;
  symbol: string;
  name: string;
  balance?: string;
}

interface TokenManagerProps {
  userAddress: string;
  network: Network;
  onTokensUpdate: (tokens: Token[]) => void;
}

export default function TokenManager({ userAddress, network, onTokensUpdate }: TokenManagerProps) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [newTokenAddress, setNewTokenAddress] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleAddToken = async () => {
    if (!isAddress(newTokenAddress)) {
      setError('Invalid token address.');
      return;
    }
    if (tokens.some(token => token.address.toLowerCase() === newTokenAddress.toLowerCase())) {
        setError('Token already added.');
        return;
    }

    setIsLoading(true);
    setError('');

    try {
      const tokenDetails = await getTokenDetails(newTokenAddress, network);
      const tokenBalance = await getTokenBalance(newTokenAddress, userAddress, network);

      const newToken: Token = { 
        ...tokenDetails, 
        address: newTokenAddress, 
        balance: tokenBalance 
      };

      const updatedTokens = [...tokens, newToken];
      setTokens(updatedTokens);
      onTokensUpdate(updatedTokens);
      setNewTokenAddress('');
    } catch (e) {
      if (e instanceof Error) {
        setError(e.message);
      } else {
        setError('Failed to add token.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleRemoveToken = (tokenAddress: string) => {
    const updatedTokens = tokens.filter(t => t.address !== tokenAddress);
    setTokens(updatedTokens);
    onTokensUpdate(updatedTokens);
  };

  return (
    <div className="bg-black/25 p-4 rounded-lg">
      <h3 className="text-lg font-bold mb-3">Manage Tokens</h3>
      <div className="flex items-center space-x-2 mb-3">
        <input
          type="text"
          value={newTokenAddress}
          onChange={(e) => setNewTokenAddress(e.target.value)}
          className="w-full p-2 bg-black/20 rounded-lg text-sm"
          placeholder="Enter ERC20 token address..."
        />
        <button 
          onClick={handleAddToken}
          disabled={isLoading || !newTokenAddress}
          className="bg-purple-600 p-2 rounded-lg hover:bg-purple-700 disabled:bg-gray-500"
        >
          {isLoading ? <Loader2 size={20} className="animate-spin"/> : <Plus size={20} />}
        </button>
      </div>
      {error && <p className="text-red-400 text-xs mb-3">{error}</p>}

      <div className="space-y-2">
        {tokens.map(token => (
          <div key={token.address} className="flex justify-between items-center bg-black/20 p-2 rounded-md">
            <div>
                <p className="font-bold">{token.name} ({token.symbol})</p>
                <p className="text-xs text-gray-400 font-mono">{token.address}</p>
            </div>
            <div className="flex items-center">
                <span className="mr-4 font-mono">{token.balance}</span>
                <button onClick={() => handleRemoveToken(token.address)} className="text-red-500 hover:text-red-400">
                    <Trash2 size={18}/>
                </button>
            </div>
          </div>
        ))}
         {tokens.length === 0 && <p className="text-center text-sm text-gray-400 py-2">No tokens added yet.</p>}
      </div>
    </div>
  );
}
