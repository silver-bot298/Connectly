import React from 'react';

interface BrandLogoProps {
  size?: number;
  variant?: 'burgundy' | 'light';
}

export const BrandLogo: React.FC<BrandLogoProps> = ({ size = 36, variant = 'burgundy' }) => {
  const bg = variant === 'burgundy' ? '#651F35' : '#F5EDE5';
  const stroke = variant === 'burgundy' ? '#F5EDE5' : '#651F35';
  const accent = '#C58C91';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect width="40" height="40" rx="12" fill={bg} />
      <path
        d="M12.5 22.5C12.5 17.2533 16.7533 13 22 13H26C27.6569 13 29 14.3431 29 16V20C29 25.2467 24.7467 29.5 19.5 29.5H14.5C13.3954 29.5 12.5 28.6046 12.5 27.5V22.5Z"
        stroke={stroke}
        strokeWidth="2.2"
      />
      <circle cx="18.2" cy="21" r="2" fill={accent} />
      <circle cx="23.8" cy="21" r="2" fill={stroke} />
      <path
        d="M19.8 21H22.2"
        stroke={accent}
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
};
