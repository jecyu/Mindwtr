import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';

type MetadataVariant = 'project' | 'context' | 'tag' | 'priority' | 'estimate' | 'age' | 'info' | 'score';

interface MetadataBadgeProps {
    label: string;
    variant: MetadataVariant;
    icon?: LucideIcon;
    dotColor?: string;
    className?: string;
    ariaLabel?: string;
}

export function MetadataBadge({ label, variant, icon: Icon, dotColor, className, ariaLabel }: MetadataBadgeProps) {
    return (
        <span
            className={cn('metadata-badge', `metadata-badge--${variant}`, className)}
            aria-label={ariaLabel ?? label}
        >
            {dotColor && (
                <span
                    className="metadata-badge__dot"
                    style={{ backgroundColor: dotColor }}
                    aria-hidden="true"
                />
            )}
            {Icon && <Icon className="metadata-badge__icon" aria-hidden="true" />}
            <span className="metadata-badge__label">{label}</span>
        </span>
    );
}
