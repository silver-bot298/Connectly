import React, { useState } from 'react';
import { Users } from 'lucide-react';

interface AvatarProps {
  name: string;
  src?: string | null;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  isOnline?: boolean;
  isGroup?: boolean;
  showPresence?: boolean;
}

const SIZE_CLASSES: Record<NonNullable<AvatarProps['size']>, string> = {
  sm: 'h-9 w-9 text-xs',
  md: 'h-11 w-11 text-sm',
  lg: 'h-12 w-12 text-base',
  xl: 'h-16 w-16 text-lg',
};

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export const Avatar: React.FC<AvatarProps> = ({
  name,
  src,
  size = 'md',
  isOnline = false,
  isGroup = false,
  showPresence = false,
}) => {
  const [imgError, setImgError] = useState(false);

  return (
    <div className="relative inline-flex shrink-0">
      {src && !imgError ? (
        <img
          src={src}
          alt={name}
          referrerPolicy="no-referrer"
          onError={() => setImgError(true)}
          className={`${SIZE_CLASSES[size]} rounded-full object-cover border border-[#C58C91]/40 bg-[#F5EDE5]`}
        />
      ) : (
        <div
          className={`${SIZE_CLASSES[size]} rounded-full flex items-center justify-center font-display font-semibold select-none border ${
            isGroup
              ? 'bg-[#C58C91]/25 text-[#651F35] dark:bg-[#C58C91]/20 dark:text-[#F5EDE5] border-[#C58C91]/50'
              : 'bg-[#651F35] text-[#F5EDE5] border-[#651F35]'
          }`}
        >
          {isGroup ? <Users className="h-4 w-4" /> : getInitials(name)}
        </div>
      )}

      {showPresence && (
        <span
          title={isOnline ? 'Online' : 'Offline'}
          className={`absolute bottom-0 right-0 block h-3 w-3 rounded-full ring-2 ring-[#FAF7F4] dark:ring-[#241218] ${
            isOnline ? 'bg-emerald-500' : 'bg-[#C58C91]/60'
          }`}
        />
      )}
    </div>
  );
};
