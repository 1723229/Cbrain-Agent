/** Panel 后端与 Web 共用的最小用户公开结构。 */
export interface PublicUser {
  user_id: string;
  user_type: 'normal' | 'system_admin';
  username: string;
  display_name?: string | null;
  email?: string | null;
  created_at: string;
}
