/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

/**
 * Shared section container for the Resource Dashboard.
 *
 * Renders a titled card with a leading icon, optional subtitle, and an optional
 * trailing slot (e.g. a status badge). Styling is built entirely from semantic
 * UnoCSS tokens so it adapts to both light and dark themes.
 */
const SectionCard: React.FC<{
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  /** Optional content rendered at the far right of the header row. */
  extra?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}> = ({ icon, title, subtitle, extra, children, className }) => (
  <section className={`bg-2 rd-16px px-[12px] md:px-[24px] py-20px ${className ?? ''}`}>
    <header className='flex items-start justify-between gap-16px mb-16px'>
      <div className='flex items-start gap-12px min-w-0'>
        <span className='shrink-0 size-32px rd-10px flex-center bg-fill-2 text-t-secondary'>{icon}</span>
        <div className='min-w-0'>
          <h3 className='m-0 text-15px font-600 text-t-primary leading-tight'>{title}</h3>
          {subtitle && <p className='m-0 mt-4px text-12px text-t-tertiary leading-snug'>{subtitle}</p>}
        </div>
      </div>
      {extra && <div className='shrink-0'>{extra}</div>}
    </header>
    {children}
  </section>
);

export default SectionCard;
