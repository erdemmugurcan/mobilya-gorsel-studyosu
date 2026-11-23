'use client';

import { useRef, useState } from 'react';
import { ImagePlus, ImageUp } from 'lucide-react';

interface Props {
  /** Single-file mode: receives the first picked or dropped file. */
  onFile?: (file: File) => void;
  /** Multi-file mode (with `multiple`): receives every picked or dropped file, in order. */
  onFiles?: (files: File[]) => void;
  multiple?: boolean;
  disabled?: boolean;
  label?: string;
  hint?: string;
  /** 'tile': a square "add" tile for a thumbnail grid (label is then the accessible name). */
  variant?: 'full' | 'tile';
}

export default function Dropzone({
  onFile,
  onFiles,
  multiple = false,
  disabled,
  label = 'Ürün fotoğrafını buraya bırakın ya da seçin',
  hint = 'JPG veya PNG',
  variant = 'full',
}: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  function emit(list: FileList | null | undefined) {
    const files = Array.from(list ?? []);
    if (files.length === 0 || disabled) return;
    if (onFiles) onFiles(multiple ? files : files.slice(0, 1));
    else onFile?.(files[0]);
  }

  const tile = variant === 'tile';
  const Icon = tile ? ImagePlus : ImageUp;

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label={tile ? `${label}. ${hint}` : undefined}
      onClick={() => !disabled && input.current?.click()}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !disabled) {
          e.preventDefault();
          input.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        emit(e.dataTransfer.files);
      }}
      className={`group flex flex-col items-center justify-center text-center transition-[background-color,border-color,transform] duration-200 ease-out ${
        tile ? 'aspect-square gap-1 rounded-control border border-dashed px-2' : 'min-h-40 gap-2 rounded-card border border-dashed px-6 py-8'
      } ${over ? 'border-accent bg-accent/10' : 'border-line-strong bg-field/50 hover:border-accent/60 hover:bg-field'} ${
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer active:scale-[0.99]'
      }`}
    >
      <Icon
        aria-hidden
        strokeWidth={1.5}
        className={`${tile ? 'size-5' : 'size-6'} transition-colors duration-200 ${over ? 'text-accent' : 'text-muted group-hover:text-accent'}`}
      />
      {tile ? (
        <span aria-hidden className="text-small text-muted group-hover:text-ink">
          Ekle
        </span>
      ) : (
        <>
          <span className="text-body text-ink">{label}</span>
          <span className="text-small text-muted">{hint}</span>
        </>
      )}
      <input
        ref={input}
        data-testid="file-input"
        type="file"
        accept="image/*,.heic,.heif"
        multiple={multiple}
        tabIndex={-1}
        className="hidden"
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          const files = e.target.files;
          emit(files);
          e.target.value = '';
        }}
      />
    </div>
  );
}
