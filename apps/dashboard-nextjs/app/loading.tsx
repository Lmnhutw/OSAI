export default function RootLoading() {
  return (
    <div className="space-y-6">
      <div className="h-28 animate-pulse rounded-[28px] bg-white/60" />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="h-[420px] animate-pulse rounded-[28px] bg-white/60" />
        <div className="h-[420px] animate-pulse rounded-[28px] bg-white/60" />
      </div>
    </div>
  );
}
