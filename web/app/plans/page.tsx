'use client';

import { Brand } from '@/components/AppShell';
import { PlansGrid } from '@/components/PlansGrid';
import { LangToggle } from '@/components/ui';

export default function PublicPlansPage() {
  return (
    <div className="content">
      <div className="row between" style={{ marginBottom: 32 }}><Brand /><LangToggle /></div>
      <PlansGrid />
    </div>
  );
}
