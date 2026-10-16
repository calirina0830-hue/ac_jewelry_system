export type ProfileRole =
  | "admin"
  | "developer"
  | "owner"
  | "staff"
  | "viewer";
export type ReservationStatus =
  | "reserved"
  | "paid"
  | "delivered"
  | "cancelled";

type MoneyInput = number | string;

export type Database = {
  public: {
    Tables: {
      customers: {
        Row: {
          id: string;
          name: string;
          facebook_name: string | null;
          email: string | null;
          phone: string | null;
          address: string | null;
          notes: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          archived_at: string | null;
        };
        Insert: {
          id?: string;
          name: string;
          facebook_name?: string | null;
          email?: string | null;
          phone?: string | null;
          address?: string | null;
          notes?: string | null;
          created_by: string;
          created_at?: string;
          updated_at?: string;
          archived_at?: string | null;
        };
        Update: {
          name?: string;
          facebook_name?: string | null;
          email?: string | null;
          phone?: string | null;
          address?: string | null;
          notes?: string | null;
          archived_at?: string | null;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          id: string;
          full_name: string;
          role: ProfileRole;
          username: string | null;
          is_active: boolean;
          avatar_url: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          full_name: string;
          role?: ProfileRole;
          username?: string | null;
          is_active?: boolean;
          avatar_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          full_name?: string;
          avatar_url?: string | null;
        };
        Relationships: [];
      };
      admin_activity_logs: {
        Row: {
          id: string;
          actor_user_id: string | null;
          actor_username: string | null;
          actor_display_name: string | null;
          action: string;
          entity_type: string | null;
          entity_id: string | null;
          description: string | null;
          metadata: Record<string, unknown>;
          created_at: string;
        };
        Insert: {
          id?: string;
          actor_user_id?: string | null;
          actor_username?: string | null;
          actor_display_name?: string | null;
          action: string;
          entity_type?: string | null;
          entity_id?: string | null;
          description?: string | null;
          metadata?: Record<string, unknown>;
          created_at?: string;
        };
        Update: Record<string, never>;
        Relationships: [];
      };
      reservation_items: {
        Row: {
          id: string;
          reservation_id: string;
          stock_item_id: string;
          item_name: string;
          sku: string;
          category: string;
          quantity: number;
          unit_price: number;
          discount: number;
          line_total: number;
          image_path: string | null;
          price_confirmed: boolean;
          ordered_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          reservation_id: string;
          stock_item_id: string;
          item_name: string;
          sku: string;
          category: string;
          quantity: number;
          unit_price: MoneyInput;
          discount?: MoneyInput;
          line_total: MoneyInput;
          image_path?: string | null;
          price_confirmed?: boolean;
          ordered_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          stock_item_id?: string;
          item_name?: string;
          sku?: string;
          category?: string;
          quantity?: number;
          unit_price?: MoneyInput;
          discount?: MoneyInput;
          line_total?: MoneyInput;
          image_path?: string | null;
          price_confirmed?: boolean;
          ordered_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "reservation_items_reservation_id_fkey";
            columns: ["reservation_id"];
            isOneToOne: false;
            referencedRelation: "reservations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "reservation_items_stock_item_id_fkey";
            columns: ["stock_item_id"];
            isOneToOne: false;
            referencedRelation: "stock_items";
            referencedColumns: ["id"];
          },
        ];
      };
      reservations: {
        Row: {
          id: string;
          reservation_no: string;
          customer_id: string;
          status: ReservationStatus;
          subtotal: number;
          discount: number;
          downpayment: number;
          total: number;
          balance: number;
          notes: string | null;
          reserved_at: string;
          paid_at: string | null;
          delivered_at: string | null;
          cancelled_at: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          archived_at: string | null;
          live_batch: string | null;
          import_batch_id: string | null;
          pricing_complete: boolean;
        };
        Insert: {
          id?: string;
          reservation_no?: string;
          customer_id: string;
          status?: ReservationStatus;
          subtotal: MoneyInput;
          discount?: MoneyInput;
          downpayment?: MoneyInput;
          total: MoneyInput;
          balance: MoneyInput;
          notes?: string | null;
          reserved_at?: string;
          paid_at?: string | null;
          delivered_at?: string | null;
          cancelled_at?: string | null;
          created_by: string;
          created_at?: string;
          updated_at?: string;
          archived_at?: string | null;
          live_batch?: string | null;
          import_batch_id?: string | null;
          pricing_complete?: boolean;
        };
        Update: {
          customer_id?: string;
          status?: ReservationStatus;
          subtotal?: MoneyInput;
          discount?: MoneyInput;
          downpayment?: MoneyInput;
          total?: MoneyInput;
          balance?: MoneyInput;
          notes?: string | null;
          paid_at?: string | null;
          delivered_at?: string | null;
          cancelled_at?: string | null;
          archived_at?: string | null;
          live_batch?: string | null;
          import_batch_id?: string | null;
          pricing_complete?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "reservations_customer_id_fkey";
            columns: ["customer_id"];
            isOneToOne: false;
            referencedRelation: "customers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "reservations_import_batch_id_fkey";
            columns: ["import_batch_id"];
            isOneToOne: false;
            referencedRelation: "reservation_import_batches";
            referencedColumns: ["id"];
          },
        ];
      };
      reservation_import_batches: {
        Row: {
          id: string;
          original_file_name: string;
          file_hash: string;
          live_batch: string | null;
          imported_by: string | null;
          confirmed_at: string;
          row_count: number;
          reservation_count: number;
          item_count: number;
          new_customer_count: number;
          total_value: number;
        };
        Insert: {
          id?: string;
          original_file_name: string;
          file_hash: string;
          live_batch?: string | null;
          imported_by?: string | null;
          confirmed_at?: string;
          row_count: number;
          reservation_count: number;
          item_count: number;
          new_customer_count?: number;
          total_value: MoneyInput;
        };
        Update: {
          original_file_name?: string;
          live_batch?: string | null;
        };
        Relationships: [];
      };
      reservation_payment_evidence: {
        Row: {
          id: string;
          payment_id: string;
          storage_path: string;
          original_file_name: string;
          mime_type: string;
          file_size: number | null;
          uploaded_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          payment_id: string;
          storage_path: string;
          original_file_name: string;
          mime_type: string;
          file_size?: number | null;
          uploaded_by?: string | null;
          created_at?: string;
        };
        Update: Record<string, never>;
        Relationships: [
          {
            foreignKeyName: "reservation_payment_evidence_payment_id_fkey";
            columns: ["payment_id"];
            isOneToOne: false;
            referencedRelation: "reservation_payments";
            referencedColumns: ["id"];
          },
        ];
      };
      reservation_payments: {
        Row: {
          id: string;
          reservation_id: string;
          amount: number;
          payment_method: string | null;
          reference_no: string | null;
          evidence_path: string | null;
          notes: string | null;
          recorded_by: string | null;
          recorded_at: string;
          voided_at: string | null;
          voided_by: string | null;
          void_reason: string | null;
        };
        Insert: {
          id?: string;
          reservation_id: string;
          amount: MoneyInput;
          payment_method?: string | null;
          reference_no?: string | null;
          evidence_path?: string | null;
          notes?: string | null;
          recorded_by?: string | null;
          recorded_at?: string;
          voided_at?: string | null;
          voided_by?: string | null;
          void_reason?: string | null;
        };
        Update: {
          payment_method?: string | null;
          reference_no?: string | null;
          evidence_path?: string | null;
          notes?: string | null;
          voided_at?: string | null;
          voided_by?: string | null;
          void_reason?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "reservation_payments_reservation_id_fkey";
            columns: ["reservation_id"];
            isOneToOne: false;
            referencedRelation: "reservations";
            referencedColumns: ["id"];
          },
        ];
      };
      reservation_status_history: {
        Row: {
          id: string;
          reservation_id: string;
          old_status: ReservationStatus | null;
          new_status: ReservationStatus;
          changed_by: string | null;
          changed_at: string;
          reason: string | null;
        };
        Insert: {
          id?: string;
          reservation_id: string;
          old_status?: ReservationStatus | null;
          new_status: ReservationStatus;
          changed_by?: string | null;
          changed_at?: string;
          reason?: string | null;
        };
        Update: Record<string, never>;
        Relationships: [
          {
            foreignKeyName: "reservation_status_history_reservation_id_fkey";
            columns: ["reservation_id"];
            isOneToOne: false;
            referencedRelation: "reservations";
            referencedColumns: ["id"];
          },
        ];
      };
      reservation_shipments: {
        Row: {
          id: string;
          shipment_no: string;
          reservation_id: string;
          status: "pending" | "shipped" | "cancelled";
          notes: string | null;
          cancel_reason: string | null;
          correction_reason: string | null;
          corrected_by: string | null;
          corrected_at: string | null;
          downpayment_applied: number;
          shipped_at: string | null;
          cancelled_at: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          shipment_no?: string;
          reservation_id: string;
          status?: "pending" | "shipped" | "cancelled";
          notes?: string | null;
          cancel_reason?: string | null;
          correction_reason?: string | null;
          corrected_by?: string | null;
          corrected_at?: string | null;
          downpayment_applied?: MoneyInput;
          shipped_at?: string | null;
          cancelled_at?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          notes?: string | null;
          cancel_reason?: string | null;
          correction_reason?: string | null;
          corrected_by?: string | null;
          corrected_at?: string | null;
          downpayment_applied?: MoneyInput;
          shipped_at?: string | null;
          cancelled_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "reservation_shipments_reservation_id_fkey";
            columns: ["reservation_id"];
            isOneToOne: false;
            referencedRelation: "reservations";
            referencedColumns: ["id"];
          },
        ];
      };
      reservation_shipment_items: {
        Row: {
          id: string;
          shipment_id: string;
          reservation_item_id: string;
          quantity: number;
          downpayment_allocated: number;
          ordered_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          shipment_id: string;
          reservation_item_id: string;
          quantity: number;
          downpayment_allocated?: MoneyInput;
          ordered_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          quantity?: number;
          downpayment_allocated?: MoneyInput;
          ordered_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "reservation_shipment_items_shipment_id_fkey";
            columns: ["shipment_id"];
            isOneToOne: false;
            referencedRelation: "reservation_shipments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "reservation_shipment_items_reservation_item_id_fkey";
            columns: ["reservation_item_id"];
            isOneToOne: false;
            referencedRelation: "reservation_items";
            referencedColumns: ["id"];
          },
        ];
      };
      stock_items: {
        Row: {
          id: string;
          sku: string;
          name: string;
          description: string | null;
          category: string;
          price: number;
          quantity: number;
          image_path: string | null;
          is_active: boolean;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          customer_facebook_name: string | null;
          archived_at: string | null;
        };
        Insert: {
          id?: string;
          sku: string;
          name: string;
          description?: string | null;
          category: string;
          price: number;
          quantity?: number;
          image_path?: string | null;
          is_active?: boolean;
          created_by: string;
          created_at?: string;
          updated_at?: string;
          archived_at?: string | null;
        };
        Update: {
          sku?: string;
          name?: string;
          description?: string | null;
          category?: string;
          price?: number;
          quantity?: number;
          image_path?: string | null;
          is_active?: boolean;
          archived_at?: string | null;
        };
        Relationships: [];
      };
    };
    Views: {
      reservation_list: {
        Row: {
          id: string;
          reservation_no: string;
          customer_id: string;
            customer_name: string;
            customer_email: string | null;
            customer_facebook_name: string | null;
            customer_phone: string | null;
          item_count: number;
          total: number;
          downpayment: number;
          balance: number;
          status: ReservationStatus;
          reserved_at: string;
          archived_at: string | null;
          updated_at: string;
          live_batch: string | null;
          import_batch_id: string | null;
          pricing_complete: boolean;
          paid_at: string | null;
          delivered_at: string | null;
          cancelled_at: string | null;
        };
        Relationships: [];
      };
    };
    Functions: {
      get_partially_paid_reservation_ids: {
        Args: Record<PropertyKey, never>;
        Returns: string[];
      };
      get_fully_delivered_reservation_ids: {
        Args: Record<PropertyKey, never>;
        Returns: string[];
      };
      archive_reservation: {
        Args: { p_reservation_id: string };
        Returns: boolean;
      };
      assert_owner_access: {
        Args: Record<PropertyKey, never>;
        Returns: void;
      };
      create_admin_account: {
        Args: {
          p_username: string;
          p_email: string;
          p_full_name: string;
          p_role: ProfileRole;
        };
        Returns: string;
      };
      get_login_identity: {
        Args: { p_username: string };
        Returns: {
          user_id: string;
          email: string;
          role: ProfileRole;
          is_active: boolean;
        }[];
      };
      is_owner: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      list_account_management_profiles: {
        Args: Record<PropertyKey, never>;
        Returns: {
          id: string;
          username: string | null;
          full_name: string;
          email: string | null;
          role: ProfileRole;
          is_active: boolean;
          created_at: string;
          last_login_at: string | null;
          last_activity_at: string | null;
        }[];
      };
      log_admin_activity: {
        Args: {
          p_action: string;
          p_entity_type?: string | null;
          p_entity_id?: string | null;
          p_description?: string | null;
          p_metadata?: Record<string, unknown>;
        };
        Returns: void;
      };
      bulk_record_reservation_payments: {
        Args: { p_payments: unknown };
        Returns: {
          reservationCount: number;
          results: unknown[];
        };
      };
      edit_reservation_payment: {
        Args: {
          p_payment_id: string;
          p_expected_payment_recorded_at: string;
          p_expected_reservation_updated_at: string;
          p_amount: MoneyInput;
          p_payment_method: string | null;
          p_reference_no: string | null;
          p_notes: string | null;
        };
        Returns: unknown;
      };
      delete_reservation_payment: {
        Args: {
          p_payment_id: string;
          p_expected_payment_recorded_at: string;
          p_expected_reservation_updated_at: string;
          p_void_reason: string;
        };
        Returns: unknown;
      };
      bulk_revert_paid_reservations: {
        Args: { p_reservation_ids: string[]; p_reason: string };
        Returns: number;
      };
      bulk_transition_reservations: {
        Args: {
          p_reservation_ids: string[];
          p_new_status: ReservationStatus;
        };
        Returns: number;
      };
      create_reservation: {
        Args: {
          p_customer_id: string;
          p_discount: MoneyInput;
          p_downpayment: MoneyInput;
          p_notes: string | null;
          p_items: unknown;
        };
        Returns: string;
      };
      create_reservation_with_downpayment: {
        Args: {
          p_customer_id: string;
          p_discount: MoneyInput;
          p_downpayment: MoneyInput;
          p_notes: string | null;
          p_items: unknown;
        };
        Returns: string;
      };
      confirm_live_order_import: {
        Args: {
          p_original_file_name: string;
          p_file_hash: string;
          p_default_live_batch: string | null;
          p_rows: unknown;
        };
        Returns: {
          batchId: string;
          reservationCount: number;
          itemCount: number;
          newCustomerCount: number;
          totalValue: number;
        };
      };
      current_profile_role: {
        Args: Record<PropertyKey, never>;
        Returns: ProfileRole;
      };
      get_dashboard_metrics: {
        Args: Record<PropertyKey, never>;
        Returns: {
          total_customers: number;
          active_stock_items: number;
          total_units: number;
          low_stock_items: number;
          active_reservations: number;
          reserved_count: number;
          paid_count: number;
          delivered_count: number;
          cancelled_count: number;
          reserved_value: number;
          paid_value: number;
          outstanding_balance: number;
        }[];
      };
      get_live_import_metrics: {
        Args: Record<PropertyKey, never>;
        Returns: {
          imported_reservations_today: number;
          imported_items_today: number;
          imported_reserved_value: number;
          new_customers_from_imports: number;
        }[];
      };
      get_payment_metrics: {
        Args: Record<PropertyKey, never>;
        Returns: {
          paid_amount: number;
          payments_awaiting_evidence: number;
        }[];
      };
      get_reservation_category_metrics: {
        Args: Record<PropertyKey, never>;
        Returns: {
          category: string;
          reserved_quantity: number;
          paid_quantity: number;
          delivered_quantity: number;
          cancelled_quantity: number;
          total_quantity: number;
          committed_value: number;
        }[];
      };
      get_reservation_status_history: {
        Args: { p_reservation_id: string };
        Returns: {
          id: string;
          old_status: ReservationStatus | null;
          new_status: ReservationStatus;
          changed_by: string | null;
          changed_by_name: string | null;
          changed_at: string;
          reason: string | null;
        }[];
      };
      get_reservable_stock: {
        Args: { p_exclude_reservation_id?: string | null };
        Returns: {
          id: string;
          sku: string;
          name: string;
          category: string;
          price: number;
          quantity: number;
          available_quantity: number;
          image_path: string | null;
        }[];
      };
      is_admin: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      restore_reservation: {
        Args: { p_reservation_id: string };
        Returns: boolean;
      };
      set_account_role: {
        Args: { p_user_id: string; p_new_role: ProfileRole };
        Returns: boolean;
      };
      set_account_status: {
        Args: { p_user_id: string; p_is_active: boolean };
        Returns: boolean;
      };
      record_reservation_payment: {
        Args: {
          p_reservation_id: string;
          p_expected_updated_at: string;
          p_amount: MoneyInput;
          p_payment_method: string | null;
          p_reference_no: string | null;
          p_notes: string | null;
          p_evidence?: unknown;
        };
        Returns: {
          paymentId: string;
          totalPaid: number;
          balance: number;
          fullySettled: boolean;
          status: ReservationStatus;
        };
      };
      cancel_reservation_shipment: {
        Args: { p_shipment_id: string; p_reason?: string | null };
        Returns: {
          shipmentId: string;
          shipmentNo: string;
          status: string;
          cancelledAt: string;
        };
      };
      edit_reservation_shipment: {
        Args: {
          p_shipment_id: string;
          p_expected_updated_at: string;
          p_shipped_at: string;
          p_notes: string | null;
          p_correction_reason: string;
        };
        Returns: {
          shipmentId: string;
          shipmentNo: string;
          status: string;
          shippedAt: string;
        };
      };
      confirm_reservation_shipment: {
        Args: { p_shipment_id: string };
        Returns: {
          shipmentId: string;
          shipmentNo: string;
          status: string;
          shippedAt: string;
        };
      };
      prepare_reservation_shipment: {
        Args: {
          p_reservation_id: string;
          p_items: unknown;
          p_downpayment_applied?: MoneyInput;
        };
        Returns: {
          shipmentId: string;
          shipmentNo: string;
          status: string;
          itemCount: number;
          totalQuantity: number;
          downpaymentApplied: MoneyInput;
        };
      };
      release_reservation_items: {
        Args: {
          p_reservation_id: string;
          p_items: unknown;
          p_release_date?: string;
          p_downpayment_applied?: MoneyInput;
          p_notes?: string | null;
        };
        Returns: {
          shipmentId: string;
          shipmentNo: string;
          status: string;
          shippedAt: string;
          itemCount: number;
          totalQuantity: number;
          downpaymentApplied: MoneyInput;
        };
      };
      reservation_downpayment_committed: {
        Args: { p_reservation_id: string };
        Returns: number;
      };
      reservation_item_committed_quantity: {
        Args: { p_reservation_item_id: string };
        Returns: number;
      };
      set_reservation_item_ordered_at: {
        Args: { p_reservation_item_id: string; p_ordered_at: string };
        Returns: string;
      };
      transition_reservation_status: {
        Args: {
          p_reservation_id: string;
          p_new_status: ReservationStatus;
          p_expected_updated_at: string;
        };
        Returns: string;
      };
      update_reservation_invoice_notes: {
        Args: {
          p_reservation_id: string;
          p_expected_updated_at: string;
          p_notes: string | null;
        };
        Returns: string;
      };
      delete_archived_reservation: {
        Args: { p_reservation_id: string };
        Returns: boolean;
      };
      delete_all_archived_reservations: {
        Args: Record<string, never>;
        Returns: number;
      };
      update_reservation: {
        Args: {
          p_reservation_id: string;
          p_expected_updated_at: string;
          p_customer_id: string;
          p_discount: MoneyInput;
          p_downpayment: MoneyInput;
          p_notes: string | null;
          p_items: unknown;
        };
        Returns: string;
      };
      update_reservation_with_payment_adjustment: {
        Args: {
          p_reservation_id: string;
          p_expected_updated_at: string;
          p_customer_id: string;
          p_discount: MoneyInput;
          p_downpayment: MoneyInput;
          p_notes: string | null;
          p_items: unknown;
        };
        Returns: string;
      };
    };
    Enums: {
      profile_role: ProfileRole;
    };
    CompositeTypes: Record<string, never>;
  };
};
