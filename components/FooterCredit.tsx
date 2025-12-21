import Image from "next/image";
import { Github } from "lucide-react";

export default function FooterCredit() {
  return (
    <footer className="text-center p-4 mt-8 text-gray-400">
      {/* Copyright */}
      <p className="text-sm mb-3">
        ©2025 built by <span className="text-white">endcore.base.eth</span>
      </p>

      {/* More details */}
      <div className="flex justify-center items-center space-x-8">
        {/* GitHub */}
        <a
          href="https://github.com/Endijuan33/ethtools.git"
          target="_blank"
          rel="noopener noreferrer"
          className="flex flex-col items-center hover:text-white transition-colors"
        >
          <Github size={26} />
          <p className="text-xs mt-1">Fork Me Here</p>
        </a>

        {/* Telegram */}
        <a
          href="https://t.me/e0303"
          target="_blank"
          rel="noopener noreferrer"
          className="flex flex-col items-center hover:text-white transition-colors"
        >
          <Image
            src="/icons/telegram.svg"
            alt="Telegram"
            width={26}
            height={26}
            className="opacity-80 hover:opacity-100"
          />
          <p className="text-xs mt-1">Get In Touch</p>
        </a>
      </div>
    </footer>
  );
}
