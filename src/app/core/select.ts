/**
 * mat-select treats an option whose value is null as "reset" and shows the
 * field empty — so "Все" / "Не указано" vanish once picked. Those options
 * carry NONE instead, and the binding maps it back:
 *
 *   <mat-select [ngModel]="geo() ?? NONE" (ngModelChange)="geo.set(orNull($event))">
 *     <mat-option [value]="NONE">Все</mat-option>
 */
export const NONE = '__none__';

export function orNull<T>(value: T): Exclude<T, typeof NONE> | null {
  return value === NONE || value == null ? null : (value as Exclude<T, typeof NONE>);
}
